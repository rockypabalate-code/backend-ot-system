const ExcelJS = require('exceljs');
const {
  getSignatureBucket,
  getStorageClient,
} = require('../../config/supabaseStorage');
const AppError = require('../../utils/appError');
const { getDepartmentPlanApprovalDetails } = require('./departmentOtPlanWorkflowService');
const { getDepartmentPlanEmployeeSignatures } = require('./employeePlanSignatureService');
const { getActualPeriod } = require('./actualOvertimeService');
const { normalize, toNumber } = require('./shared/utils');

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

function validateDocumentSignatures(
  actualPeriod,
  employeeSignatures,
  approvedApprovals,
  employeeSignaturesRequired = true
) {
  const employeeSignatureKeys = new Set(employeeSignatures.map((signature) => (
    `${normalize(signature.sourceEmployeePlanId)}:${normalize(signature.employeeId)}`
  )));
  const missingEmployeeSignature = employeeSignaturesRequired
    && actualPeriod.entries.some((entry) => (
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

async function buildActualDocumentDownload(actualPeriodId, user) {
  const actualPeriod = await getActualPeriod(actualPeriodId, user);
  if (actualPeriod.status !== 'finalized') {
    throw new AppError(
      'The Actual OT period must be finalized before generating its Excel document.',
      400,
      'ACTUAL_OVERTIME_NOT_FINALIZED'
    );
  }

  try {
    const plan = await getDepartmentPlanApprovalDetails(actualPeriod.sourceDepartmentPlanId);

    if (!plan) {
      throw new AppError(
        'The source Department OT Plan could not be found.',
        404,
        'ACTUAL_DOCUMENT_SOURCE_PLAN_NOT_FOUND'
      );
    }

    const employeeSignatures = await getDepartmentPlanEmployeeSignatures(actualPeriod.sourceDepartmentPlanId);
    const approvedApprovals = plan.approvals.filter((approval) => approval.status === 'approved');
    validateDocumentSignatures(
      actualPeriod,
      employeeSignatures,
      approvedApprovals,
      plan.employeeSignaturesRequired !== false
    );
    const signatureImages = await downloadSignatureImages(employeeSignatures, approvedApprovals);
    const buffer = await buildActualOvertimeWorkbook(
      actualPeriod,
      employeeSignatures,
      approvedApprovals,
      signatureImages
    );

    return {
      actualPeriodId: actualPeriod.actualPeriodId,
      buffer,
      contentType: XLSX_CONTENT_TYPE,
      fileName: `${actualPeriod.actualPeriodId}.xlsx`,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Unable to generate the final Actual OT Excel document.', 500, 'ACTUAL_DOCUMENT_GENERATION_FAILED');
  }
}

module.exports = {
  buildActualOvertimeWorkbook,
  buildActualDocumentDownload,
  validateDocumentSignatures,
};
