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

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function normalize(value) {
  return String(value || '').trim();
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function mapFinalDocument(row) {
  return {
    documentId: row.document_id,
    planId: row.plan_id,
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

async function getFinalDocument(planId, executor = { query }) {
  const result = await executor.query(
    `
      SELECT *
      FROM overtime_plan_documents
      WHERE plan_id = $1
      LIMIT 1;
    `,
    [normalize(planId)]
  );

  return result.rows[0] ? mapFinalDocument(result.rows[0]) : null;
}

async function markDocumentPending(planId, generatedBy) {
  const result = await query(
    `
      INSERT INTO overtime_plan_documents (
        document_id,
        plan_id,
        file_type,
        generated_by,
        status
      )
      VALUES ($1, $2, 'xlsx', $3, 'pending')
      ON CONFLICT (plan_id)
      DO UPDATE SET
        file_path = NULL,
        generated_by = EXCLUDED.generated_by,
        generated_at = NULL,
        status = 'pending',
        error_message = NULL,
        updated_at = NOW()
      RETURNING *;
    `,
    [`OTDOCUMENT-${crypto.randomUUID()}`, normalize(planId), normalize(generatedBy)]
  );

  return mapFinalDocument(result.rows[0]);
}

async function markDocumentReady(documentId, filePath) {
  const result = await query(
    `
      UPDATE overtime_plan_documents
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

  return mapFinalDocument(result.rows[0]);
}

async function markDocumentFailed(documentId, error) {
  if (!documentId) {
    return;
  }

  try {
    await query(
      `
        UPDATE overtime_plan_documents
        SET status = 'failed',
            error_message = $2,
            updated_at = NOW()
        WHERE document_id = $1;
      `,
      [documentId, normalize(error && error.message).slice(0, 1000) || 'Document generation failed.']
    );
  } catch (updateError) {
    console.error('Unable to record final document failure.', updateError.message);
  }
}

function employeeSignatureKey(sourcePlanId, employeeId) {
  return `${normalize(sourcePlanId)}:${normalize(employeeId)}`;
}

function validateDocumentData(plan, employeeSignatures, approvedApprovals) {
  const employeeSignatureKeys = new Set(
    employeeSignatures.map((record) => employeeSignatureKey(record.sourceEmployeePlanId, record.employeeId))
  );
  const missingEmployeeSignature = plan.employeeSignaturesRequired !== false
    && plan.items.some((item) => (
      !item.sourceEmployeePlanId
      || !employeeSignatureKeys.has(employeeSignatureKey(item.sourceEmployeePlanId, item.employeeId))
    ));

  if (missingEmployeeSignature) {
    throw new AppError(
      'The Department OT Plan has an item without a valid accepted employee signature.',
      409,
      'SIGNATURE_RECORDS_INCOMPLETE'
    );
  }

  if (
    approvedApprovals.length === 0
    || approvedApprovals.some((approval) => !approval.signatureFilePath || !approval.actedAt)
  ) {
    throw new AppError(
      'The Department OT Plan has an approved step without a signature snapshot.',
      409,
      'APPROVAL_SIGNATURES_INCOMPLETE'
    );
  }

  const finalApproval = approvedApprovals.find((approval) => ['hr', 'admin'].includes(approval.approverRole));

  if (!finalApproval) {
    throw new AppError(
      'The Department OT Plan has no completed HR/Admin final approval.',
      409,
      'FINAL_APPROVAL_SIGNATURE_MISSING'
    );
  }
}

async function downloadSignatureImage(filePath) {
  const { data, error } = await getStorageClient()
    .storage
    .from(getSignatureBucket())
    .download(filePath);

  if (error || !data) {
    throw new AppError(
      'A signature image required by the final document could not be downloaded.',
      502,
      'SIGNATURE_IMAGE_DOWNLOAD_FAILED'
    );
  }

  return Buffer.from(await data.arrayBuffer());
}

async function downloadSignatureImages(employeeSignatures, approvedApprovals) {
  const paths = new Set([
    ...employeeSignatures.map((record) => record.signatureFilePath),
    ...approvedApprovals.map((approval) => approval.signatureFilePath),
  ]);
  const entries = await Promise.all(
    [...paths].map(async (filePath) => [filePath, await downloadSignatureImage(filePath)])
  );
  return new Map(entries);
}

function imageExtension(mimeType, filePath) {
  if (mimeType === 'image/jpeg' || /\.jpe?g$/i.test(filePath)) {
    return 'jpeg';
  }

  return 'png';
}

function applyHeaderStyle(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF23565B' } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 24;
}

function applyTableBorders(row, startColumn, endColumn) {
  for (let column = startColumn; column <= endColumn; column += 1) {
    row.getCell(column).border = {
      top: { style: 'thin', color: { argb: 'FFB7C3C5' } },
      left: { style: 'thin', color: { argb: 'FFB7C3C5' } },
      bottom: { style: 'thin', color: { argb: 'FFB7C3C5' } },
      right: { style: 'thin', color: { argb: 'FFB7C3C5' } },
    };
    row.getCell(column).alignment = { vertical: 'middle', wrapText: true };
  }
}

function addEmbeddedSignature(workbook, worksheet, imageIds, signatureImages, record, columnIndex, rowNumber) {
  let imageId = imageIds.get(record.signatureFilePath);

  if (imageId === undefined) {
    imageId = workbook.addImage({
      buffer: signatureImages.get(record.signatureFilePath),
      extension: imageExtension(record.signatureMimeType, record.signatureFilePath),
    });
    imageIds.set(record.signatureFilePath, imageId);
  }

  worksheet.addImage(imageId, {
    tl: { col: columnIndex + 0.12, row: rowNumber - 0.9 },
    ext: { width: 110, height: 36 },
    editAs: 'oneCell',
  });
}

async function buildFinalDocumentWorkbook(plan, employeeSignatures, approvedApprovals, signatureImages) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Overtime Approval System';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet('Official OT Plan', {
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      paperSize: 9,
    },
  });
  worksheet.columns = [
    { width: 14 },
    { width: 25 },
    { width: 14 },
    { width: 12 },
    { width: 34 },
    { width: 23 },
    { width: 22 },
    { width: 20 },
  ];
  worksheet.views = [{ state: 'frozen', ySplit: 8 }];

  worksheet.mergeCells('A1:H1');
  worksheet.getCell('A1').value = 'DEPARTMENT OVERTIME PLAN';
  worksheet.getCell('A1').font = { bold: true, size: 18, color: { argb: 'FF173F43' } };
  worksheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  worksheet.getRow(1).height = 30;

  worksheet.getCell('A3').value = 'Department';
  worksheet.getCell('B3').value = plan.departmentName || plan.departmentId;
  worksheet.getCell('A4').value = 'Period';
  worksheet.getCell('B4').value = `${plan.periodStartDate} to ${plan.periodEndDate}`;
  worksheet.getCell('A5').value = 'Status';
  worksheet.getCell('B5').value = plan.status;
  worksheet.getCell('A6').value = 'Total planned hours';
  worksheet.getCell('B6').value = Number(plan.plannedHours || 0);
  ['A3', 'A4', 'A5', 'A6'].forEach((cell) => {
    worksheet.getCell(cell).font = { bold: true, color: { argb: 'FF173F43' } };
  });

  const employeeHeader = worksheet.getRow(8);
  employeeHeader.values = [
    'Employee No.',
    'Employee',
    'OT Date',
    'Hours',
    'Reason',
    'Confirmation',
    'Confirmed At',
    'Employee Signature',
  ];
  applyHeaderStyle(employeeHeader);

  const employeeSignatureMap = new Map(
    employeeSignatures.map((record) => [
      employeeSignatureKey(record.sourceEmployeePlanId, record.employeeId),
      record,
    ])
  );
  const imageIds = new Map();
  const sortedItems = [...plan.items].sort((left, right) => (
    left.employeeName.localeCompare(right.employeeName)
    || left.plannedDate.localeCompare(right.plannedDate)
  ));

  for (const item of sortedItems) {
    const signature = employeeSignatureMap.get(
      employeeSignatureKey(item.sourceEmployeePlanId, item.employeeId)
    );
    const row = worksheet.addRow([
      item.employeeNo,
      item.employeeName,
      item.plannedDate,
      Number(item.plannedHours),
      item.reason,
      signature
        ? signature.confirmationMethod === 'self'
          ? 'Employee self-confirmed'
          : 'Supervisor confirmed on behalf'
        : 'Assigned by supervisor',
      signature ? signature.signedAt : '',
      '',
    ]);
    row.height = 40;
    row.getCell(4).numFmt = '0.00';
    applyTableBorders(row, 1, 8);
    if (signature) {
      addEmbeddedSignature(workbook, worksheet, imageIds, signatureImages, signature, 7, row.number);
    }
  }

  const totalRow = worksheet.addRow(['', '', 'TOTAL HOURS', Number(plan.plannedHours || 0), '', '', '', '']);
  totalRow.font = { bold: true };
  totalRow.getCell(4).numFmt = '0.00';
  applyTableBorders(totalRow, 1, 8);

  const approvalTitleRow = worksheet.addRow([]);
  approvalTitleRow.getCell(1).value = 'APPROVAL RECORDS';
  approvalTitleRow.getCell(1).font = { bold: true, size: 13, color: { argb: 'FF173F43' } };
  const approvalHeader = worksheet.addRow([
    'Role',
    'Approval Step',
    'Approver',
    'Status',
    'Approved At',
    'Remarks',
    'Approver Signature',
    '',
  ]);
  worksheet.mergeCells(approvalHeader.number, 7, approvalHeader.number, 8);
  applyHeaderStyle(approvalHeader);

  for (const approval of approvedApprovals) {
    const row = worksheet.addRow([
      approval.approverRole,
      approval.stepName,
      approval.actedByName || approval.actedBy,
      approval.status,
      approval.actedAt,
      approval.remarks,
      '',
      '',
    ]);
    worksheet.mergeCells(row.number, 7, row.number, 8);
    row.height = 40;
    applyTableBorders(row, 1, 8);
    addEmbeddedSignature(workbook, worksheet, imageIds, signatureImages, approval, 6, row.number);
  }

  const auditSheet = workbook.addWorksheet('Signature Audit');
  auditSheet.columns = [
    { width: 22 },
    { width: 25 },
    { width: 24 },
    { width: 24 },
    { width: 25 },
    { width: 25 },
    { width: 55 },
  ];
  const auditHeader = auditSheet.addRow([
    'Record Type',
    'Record ID',
    'Employee / Role',
    'Signature Owner',
    'Action By',
    'Action At',
    'Storage Path',
  ]);
  applyHeaderStyle(auditHeader);

  for (const signature of employeeSignatures) {
    auditSheet.addRow([
      signature.confirmationMethod,
      signature.signatureRecordId,
      `${signature.employeeNo} ${signature.employeeName}`.trim(),
      signature.signatureOwnerUserId,
      signature.actedByUserId,
      signature.signedAt,
      signature.signatureFilePath,
    ]);
  }
  for (const approval of approvedApprovals) {
    auditSheet.addRow([
      'approval',
      approval.approvalId,
      approval.approverRole,
      approval.actedBy,
      approval.actedBy,
      approval.actedAt,
      approval.signatureFilePath,
    ]);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function uploadFinalDocument(filePath, buffer) {
  const { error } = await getStorageClient()
    .storage
    .from(getDocumentBucket())
    .upload(filePath, buffer, {
      contentType: XLSX_CONTENT_TYPE,
      upsert: true,
    });

  if (error) {
    throw new AppError('Unable to upload the final Excel document.', 502, 'FINAL_DOCUMENT_UPLOAD_FAILED');
  }
}

async function generateFinalDocument(planId, generatedBy, options = {}) {
  const plan = await getDepartmentPlanApprovalDetails(planId);

  if (!plan) {
    throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
  }

  if ((plan.planScope || 'employee') !== 'department') {
    throw new AppError('Final documents are available only for Department OT Plans.', 400, 'PLAN_SCOPE_NOT_DEPARTMENT');
  }

  if (plan.status !== 'approved') {
    throw new AppError(
      'The Department OT Plan must be fully approved before generating its final document.',
      400,
      'PLAN_NOT_APPROVED'
    );
  }

  const existingDocument = await getFinalDocument(plan.planId);

  if (existingDocument && existingDocument.status === 'ready' && options.force !== true) {
    return existingDocument;
  }

  let document = await markDocumentPending(plan.planId, generatedBy);

  try {
    const employeeSignatures = await getDepartmentPlanEmployeeSignatures(plan.planId);
    const approvedApprovals = plan.approvals.filter((approval) => approval.status === 'approved');
    validateDocumentData(plan, employeeSignatures, approvedApprovals);
    const signatureImages = await downloadSignatureImages(employeeSignatures, approvedApprovals);
    const workbookBuffer = await buildFinalDocumentWorkbook(
      plan,
      employeeSignatures,
      approvedApprovals,
      signatureImages
    );
    const filePath = `final-documents/${plan.planId}/${document.documentId}.xlsx`;
    await uploadFinalDocument(filePath, workbookBuffer);
    document = await markDocumentReady(document.documentId, filePath);
    return document;
  } catch (error) {
    await markDocumentFailed(document.documentId, error);

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      'Unable to generate the final Excel document.',
      500,
      'FINAL_DOCUMENT_GENERATION_FAILED'
    );
  }
}

async function createFinalDocumentSignedUrl(document) {
  if (!document || document.status !== 'ready' || !document.filePath) {
    throw new AppError('The final Excel document is not ready.', 409, 'FINAL_DOCUMENT_NOT_READY');
  }

  const expiresInSeconds = getDocumentUrlTtlSeconds();
  const { data, error } = await getStorageClient()
    .storage
    .from(getDocumentBucket())
    .createSignedUrl(document.filePath, expiresInSeconds, {
      download: `${document.planId}.xlsx`,
    });

  if (error || !data || !data.signedUrl) {
    throw new AppError('Unable to create a final document URL.', 502, 'FINAL_DOCUMENT_URL_FAILED');
  }

  return {
    ...document,
    signedUrl: data.signedUrl,
    expiresInSeconds,
  };
}

module.exports = {
  buildFinalDocumentWorkbook,
  createFinalDocumentSignedUrl,
  generateFinalDocument,
  getFinalDocument,
  validateDocumentData,
};
