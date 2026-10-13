import { Counter } from '../models/Counter.js';

export async function nextEmployeeCode() {
  const counter = await Counter.findByIdAndUpdate(
    'employee',
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return `ADB-EMP-${String(counter.value).padStart(4, '0')}`;
}
