import mongoose from 'mongoose';
import '../app.js';
import { connectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';
try {
  await connectDatabase();
  logger.info('Department masters and employee references migrated successfully');
} finally { await mongoose.disconnect(); }
