const express = require('express');
const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/authRoutes');
const overtimeRoutes = require('./routes/overtimeRoutes');
const userRoutes = require('./routes/userRoutes');
const notificationRoutes = require('./routes/notificationRoutes');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    message: 'Backend API is running.',
    routes: {
      login: 'POST /api/auth/login',
      accounts: 'GET/POST/PATCH/DELETE /api/admin/users',
      forceDeleteAccount: 'DELETE /api/admin/users/:userId/force',
      purgeOvertimeData: 'POST /api/admin/overtime/plans/:departmentPlanId/purge-data',
      impersonateUser: 'POST /api/admin/impersonations',
      createAccount: 'POST /api/admin/users',
      legacyCreateAccount: 'POST /api/auth/register (admin token required)',
      me: 'GET /api/auth/me',
      signature: 'GET own / POST admin-managed /api/users/signature; DELETE /api/users/signature/:userId',
      adminDashboard: 'GET /api/admin/dashboard',
      overtimePlans: 'GET/POST /api/overtime/plans',
      overtimePlanItems: 'POST/PATCH/DELETE /api/overtime/plans/:planId/items',
      overtimePlanWorkflow: 'PATCH /api/overtime/plans/:planId/submit|approve|reject|close',
      overtimePlanFinalDocument: 'GET/POST /api/overtime/plans/:planId/final-document',
      actualOvertime: 'GET /api/overtime/actual-periods/:actualPeriodId',
      actualOvertimeAdjustment: 'PATCH /api/overtime/actual-entries/:actualEntryId',
      actualOvertimeComment: 'POST /api/overtime/actual-entries/:actualEntryId/comments',
      actualOvertimeFinalDocument: 'GET/POST /api/overtime/actual-periods/:actualPeriodId/final-document',
      employees: 'GET/POST/PATCH/DELETE /api/overtime/employees; GET own /api/overtime/employees/me',
      departments: 'GET/POST/PATCH/DELETE /api/overtime/departments',
      policies: 'GET /api/overtime/policies',
      notifications: 'GET/PATCH /api/notifications',
    },
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/overtime', overtimeRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notifications', notificationRoutes);

app.use((req, res) => {
  res.status(404).json({ message: 'Route not found.' });
});

app.use((error, req, res, next) => {
  const statusCode = error.statusCode || 500;
  const response = {
    message: statusCode >= 500 ? 'Internal server error.' : error.message,
  };

  if (error.code && statusCode < 500) {
    response.code = error.code;
  }

  if (statusCode >= 500) {
    console.error(error);
  } else {
    console.warn(error.message);
  }

  res.status(statusCode).json(response);
});

module.exports = app;
