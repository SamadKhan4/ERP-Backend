import mongoose from 'mongoose';
import { env } from './env.js';
mongoose.set('bufferCommands', false);
// Models are imported before connecting. Defer collection/index work until
// MongoDB is ready rather than letting model compilation start it early.
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);
export async function connectDatabase() {
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection();
    await model.createIndexes();
  }
  return mongoose.connection;
}
