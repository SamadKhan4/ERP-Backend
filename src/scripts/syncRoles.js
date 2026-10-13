import mongoose from 'mongoose';
import { connectDatabase } from '../config/db.js';
import { syncRoles } from '../services/roleService.js';
import { logger } from '../config/logger.js';
try {
  await connectDatabase();
  await syncRoles();
  logger.info(
    'Synchronized the nine supported roles; existing permission assignments preserved.',
  );
} finally {
  await mongoose.disconnect();
}
