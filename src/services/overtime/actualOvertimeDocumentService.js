const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { query } = require('../../config/database');
const {
  getDocumentBucket,
  getDocumentUrlTtlSeconds,
  getSignatureBucket,
  getStorageClient,
} = require('../../config/supabaseStorage');
const AppError = require('../../utils/appError');
const { getDepartmentPlanApprovalDetails } = require('./departmentOtPlanWorkflowService');
const { getDepartmentPlanEmployeeSignatures } = require('./employeePlanSignatureService');
const { getActualPeriod } = require('./actualOvertimeService');
const { iso, normalize, toNumber } = require('./shared/utils');

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function mapActualDocument(row) {
  return {
    documentId: row.document_id,
    actualPeriodId: row.actual_period_id,
    filePath: row.file_path || '',
    fileType: row.file_type,
    generatedBy: row.generated_by || '',
    generatedAt: iso(row.generated_at),
    status: row.status,
    errorMessage: row.error_message || '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function findActualDocument(actualPeriodId, executor = { query }) {
  const result = await executor.query(
    `
      SELECT *
      FROM overtime_actual_documents
      WHERE actual_period_id = $1
      LIMIT 1;
    `,
    [normalize(actualPeriodId)]
  );
  return result.rows[0] ? mapActualDocument(result.rows[0]) : null;
}

async function markDocumentPending(actualPeriodId, generatedBy) {
  const result = await query(
    `
      INSERT INTO overtime_actual_documents (
        document_id,
        actual_period_id,
        generated_by,
        status
      )
      VALUES ($1, $2, $3, 'pending')
      ON CONFLICT (actual_period_id)
      DO UPDATE SET
        file_path = NULL,
        generated_by = EXCLUDED.generated_by,
        generated_at = NULL,
        status = 'pending',
        error_message = NULL,
        updated_at = NOW()
      RETURNING *;
    `,
    [`ACTUALDOCUMENT-${crypto.randomUUID()}`, normalize(actualPeriodId), normalize(generatedBy)]
  );
  return mapActualDocument(result.rows[0]);
}

async function markDocumentReady(documentId, filePath) {
  const result = await query(
    `
      UPDATE overtime_actual_documents
      SET file_path = $2,
          status = 'ready',
          generated_at = NOW(),
          error_message = NULL,
          updated_at = NOW()
      WHERE document_id = $1
      RETURNING *;
    `,
    [documentId, filePath]
  );
  return mapActualDocument(result.rows[0]);
}

async function markDocumentFailed(documentId, error) {
  if (!documentId) return;
  try {
    await query(
      `
        UPDATE overtime_actual_documents
        SET status = 'failed',
            error_message = $2,
            updated_at = NOW()
        WHERE document_id = $1;
      `,
      [documentId, normalize(error && error.message).slice(0, 1000) || 'Document generation failed.']
    );
  } catch (updateError) {
    console.error('Unable to record Actual OT document failure.', updateError.message);
  }
}

function applyHeaderStyle(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF285943' } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 30;
  row.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF6B7280' } },
      left: { style: 'thin', color: { argb: 'FF6B7280' } },
      bottom: { style: 'thin', color: { argb: 'FF6B7280' } },
      right: { style: 'thin', color: { argb: 'FF6B7280' } },
    };
  });
}

function applyBodyBorders(row) {
  row.alignment = { vertical: 'top', wrapText: true };
  row.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
    };
  });
}

function imageExtension(record) {
  return record.signatureMimeType === 'image/jpeg'
    || /\.jpe?g$/i.test(record.signatureFilePath)
    ? 'jpeg'
    : 'png';
}

async function downloadSignatureImages(employeeSignatures, approvals) {
  const paths = new Set([
    ...employeeSignatures.map((record) => record.signatureFilePath),
    ...approvals.map((record) => record.signatureFilePath),
  ].filter(Boolean));
  const entries = await Promise.all([...paths].map(async (filePath) => {
    const { data, error } = await getStorageClient()
      .storage
      .from(getSignatureBucket())
      .download(filePath);
    if (error || !data) {
      throw new AppError(
        'A signature image required by the Actual OT document could not be downloaded.',
        502,
        'SIGNATURE_IMAGE_DOWNLOAD_FAILED'
      );
    }
    return [filePath, Buffer.from(await data.arrayBuffer())];
  }));
  return new Map(entries);
}

function addSignatureImage(workbook, worksheet, imageIds, images, record, rowNumber) {
  const buffer = images.get(record.signatureFilePath);
  if (!buffer) return;
  let imageId = imageIds.get(record.signatureFilePath);
  if (!imageId) {
    imageId = workbook.addImage({ buffer, extension: imageExtension(record) });
    imageIds.set(record.signatureFilePath, imageId);
  }
  worksheet.addImage(imageId, {
    tl: { col: 5.1, row: rowNumber - 0.9 },
    ext: { width: 145, height: 42 },
  });
}

function formatComments(comments) {
  return (comments || [])
    .map((comment) => `${comment.userName || comment.userId}: ${comment.remarks}`)
    .join('\n');
}

function validateDocumentSignatures(actualPeriod, employeeSignatures, approvedApprovals) {
  const employeeSignatureKeys = new Set(employeeSignatures.map((signature) => (
    `${normalize(signature.sourceEmployeePlanId)}:${normalize(signature.employeeId)}`
  )));
  const missingEmployeeSignature = actualPeriod.entries.some((entry) => (
    !entry.sourceEmployeePlanId
    || !employeeSignatureKeys.has(`${normalize(entry.sourceEmployeePlanId)}:${normalize(entry.employeeId)}`)
  ));
  if (missingEmployeeSignature) {
    throw new AppError(
      'An Actual OT entry has no accepted employee signature from its source plan.',
      409,
      'ACTUAL_DOCUMENT_EMPLOYEE_SIGNATURES_INCOMPLETE'
    );
  }
  if (
    approvedApprovals.length === 0
    || approvedApprovals.some((approval) => !approval.signatureFilePath || !approval.actedAt)
  ) {
    throw new AppError(
      'An approved Department OT Plan step has no valid signature snapshot.',
      409,
      'ACTUAL_DOCUMENT_APPROVAL_SIGNATURES_INCOMPLETE'
    );
  }
  if (!approvedApprovals.some((approval) => ['admin', 'hr'].includes(approval.approverRole))) {
    throw new AppError(
      'The Department OT Plan has no completed HR/Admin final approval signature.',
      409,
      'ACTUAL_DOCUMENT_FINAL_SIGNATURE_MISSING'
    );
  }
}

async function buildActualOvertimeWorkbook(
  actualPeriod,
  employeeSignatures,
  approvedApprovals,
  signatureImages
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OT Approval Backend';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet('Actual OT');
  worksheet.properties.defaultRowHeight = 20;
  worksheet.views = [{ state: 'frozen', ySplit: 7 }];
  worksheet.columns = [
    { width: 14 }, { width: 24 }, { width: 13 }, { width: 14 }, { width: 14 },
    { width: 12 }, { width: 30 }, { width: 34 }, { width: 44 },
  ];
  worksheet.mergeCells('A1:I1');
  worksheet.getCell('A1').value = 'FINAL ACTUAL OVERTIME RECORD';
  worksheet.getCell('A1').font = { bold: true, size: 18, color: { argb: 'FF173A2B' } };
  worksheet.getCell('A1').alignment = { horizontal: 'center' };
  worksheet.addRow(['Department', actualPeriod.departmentName, '', 'Period', `${actualPeriod.periodStartDate} to ${actualPeriod.periodEndDate}`]);
  worksheet.addRow(['Source Department Plan', actualPeriod.sourceDepartmentPlanId, '', 'Status', actualPeriod.status]);
  worksheet.addRow(['Finalized By', actualPeriod.finalizedByName || actualPeriod.finalizedBy, '', 'Finalized At', actualPeriod.finalizedAt]);
  worksheet.addRow(['Finalization Remarks', actualPeriod.finalizationRemarks]);
  worksheet.addRow([]);
  const header = worksheet.addRow([
    'Employee No', 'Employee', 'Date', 'Planned Hours', 'Actual Hours', 'Variance',
    'Planned Reason', 'Adjustment Remarks', 'Employee Comments',
  ]);
  applyHeaderStyle(header);

  for (const entry of actualPeriod.entries) {
    const row = worksheet.addRow([
      entry.employeeNo,
      entry.employeeName,
      entry.actualDate,
      entry.plannedHours,
      entry.actualHours,
      entry.varianceHours,
      entry.plannedReason,
      entry.lastAdjustmentRemarks,
      formatComments(entry.comments),
    ]);
    row.height = 34;
    applyBodyBorders(row);
    row.getCell(4).numFmt = '0.00';
    row.getCell(5).numFmt = '0.00';
    row.getCell(6).numFmt = '0.00';
  }

  const totalRow = worksheet.addRow([
    '', 'TOTAL', '',
    actualPeriod.entries.reduce((sum, entry) => sum + toNumber(entry.plannedHours), 0),
    actualPeriod.entries.reduce((sum, entry) => sum + toNumber(entry.actualHours), 0),
    actualPeriod.entries.reduce((sum, entry) => sum + toNumber(entry.varianceHours), 0),
  ]);
  totalRow.font = { bold: true };
  totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F1EC' } };
  applyBodyBorders(totalRow);

  const auditSheet = workbook.addWorksheet('Adjustment Audit');
  auditSheet.columns = [
    { width: 20 }, { width: 14 }, { width: 24 }, { width: 13 }, { width: 13 },
    { width: 25 }, { width: 40 }, { width: 24 },
  ];
  const auditHeader = auditSheet.addRow([
    'Adjustment ID', 'Employee No', 'Employee', 'Previous Hours', 'New Hours',
    'Changed By', 'Remarks', 'Changed At',
  ]);
  applyHeaderStyle(auditHeader);
  for (const entry of actualPeriod.entries) {
    for (const adjustment of entry.adjustments || []) {
      const row = auditSheet.addRow([
        adjustment.adjustmentId,
        entry.employeeNo,
        entry.employeeName,
        adjustment.previousHours,
        adjustment.newHours,
        adjustment.changedByName || adjustment.changedBy,
        adjustment.remarks,
        adjustment.changedAt,
      ]);
      applyBodyBorders(row);
    }
  }

  const signatureSheet = workbook.addWorksheet('Approval Signatures');
  signatureSheet.columns = [
    { width: 22 }, { width: 24 }, { width: 24 }, { width: 25 }, { width: 25 }, { width: 25 },
  ];
  const signatureHeader = signatureSheet.addRow([
    'Record Type', 'Employee / Role', 'Signed By', 'Action At', 'Remarks', 'Signature',
  ]);
  applyHeaderStyle(signatureHeader);
  const imageIds = new Map();

  for (const signature of employeeSignatures) {
    const row = signatureSheet.addRow([
      signature.confirmationMethod,
      `${signature.employeeNo} ${signature.employeeName}`.trim(),
      signature.actedByUserId,
      signature.signedAt,
      signature.remarks,
      '',
    ]);
    row.height = 48;
    applyBodyBorders(row);
    addSignatureImage(workbook, signatureSheet, imageIds, signatureImages, signature, row.number);
  }

  for (const approval of approvedApprovals) {
    const row = signatureSheet.addRow([
      'approval',
      approval.stepName || approval.approverRole,
      approval.actedByName || approval.actedBy,
      approval.actedAt,
      approval.remarks,
      '',
    ]);
    row.height = 48;
    applyBodyBorders(row);
    addSignatureImage(workbook, signatureSheet, imageIds, signatureImages, approval, row.number);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function uploadDocument(filePath, buffer) {
  const { error } = await getStorageClient()
    .storage
    .from(getDocumentBucket())
    .upload(filePath, buffer, { contentType: XLSX_CONTENT_TYPE, upsert: true });
  if (error) {
    throw new AppError(
      'Unable to upload the final Actual OT Excel document.',
      502,
      'ACTUAL_DOCUMENT_UPLOAD_FAILED'
    );
  }
}

async function generateActualDocument(actualPeriodId, user, options = {}) {
  if (!['admin', 'hr'].includes(user.role)) {
    throw new AppError('Only Admin or HR can generate the final Actual OT document.', 403, 'ACTUAL_DOCUMENT_GENERATE_FORBIDDEN');
  }
  const actualPeriod = await getActualPeriod(actualPeriodId, user);
  if (actualPeriod.status !== 'finalized') {
    throw new AppError(
      'The Actual OT period must be finalized before generating its Excel document.',
      400,
      'ACTUAL_OVERTIME_NOT_FINALIZED'
    );
  }

  const existingDocument = await findActualDocument(actualPeriod.actualPeriodId);
  if (existingDocument && existingDocument.status === 'ready' && options.force !== true) {
    return existingDocument;
  }

  let document = await markDocumentPending(actualPeriod.actualPeriodId, user.id);
  try {
    const plan = await getDepartmentPlanApprovalDetails(actualPeriod.sourceDepartmentPlanId);
    const employeeSignatures = await getDepartmentPlanEmployeeSignatures(actualPeriod.sourceDepartmentPlanId);
    const approvedApprovals = plan.approvals.filter((approval) => approval.status === 'approved');
    validateDocumentSignatures(actualPeriod, employeeSignatures, approvedApprovals);
    const signatureImages = await downloadSignatureImages(employeeSignatures, approvedApprovals);
    const buffer = await buildActualOvertimeWorkbook(
      actualPeriod,
      employeeSignatures,
      approvedApprovals,
      signatureImages
    );
    const filePath = `actual-documents/${actualPeriod.actualPeriodId}/${document.documentId}.xlsx`;
    await uploadDocument(filePath, buffer);
    document = await markDocumentReady(document.documentId, filePath);
    return document;
  } catch (error) {
    await markDocumentFailed(document.documentId, error);
    if (error instanceof AppError) throw error;
    throw new AppError('Unable to generate the final Actual OT Excel document.', 500, 'ACTUAL_DOCUMENT_GENERATION_FAILED');
  }
}

async function getActualDocument(actualPeriodId, user) {
  await getActualPeriod(actualPeriodId, user);
  return findActualDocument(actualPeriodId);
}

async function createActualDocumentSignedUrl(document) {
  if (!document || document.status !== 'ready' || !document.filePath) {
    throw new AppError('The final Actual OT Excel document is not ready.', 409, 'ACTUAL_DOCUMENT_NOT_READY');
  }
  const expiresInSeconds = getDocumentUrlTtlSeconds();
  const { data, error } = await getStorageClient()
    .storage
    .from(getDocumentBucket())
    .createSignedUrl(document.filePath, expiresInSeconds, {
      download: `${document.actualPeriodId}.xlsx`,
    });
  if (error || !data || !data.signedUrl) {
    throw new AppError('Unable to create an Actual OT document URL.', 502, 'ACTUAL_DOCUMENT_URL_FAILED');
  }
  return { ...document, signedUrl: data.signedUrl, expiresInSeconds };
}

module.exports = {
  buildActualOvertimeWorkbook,
  createActualDocumentSignedUrl,
  findActualDocument,
  generateActualDocument,
  getActualDocument,
};
