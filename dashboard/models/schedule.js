function getScheduleModel(mongoose) {
  if (mongoose.models.Schedule) return mongoose.models.Schedule;
  const scheduleSchema = new mongoose.Schema({
    label:     { type: String, default: 'Unnamed' },
    channel:   { type: String, required: true },
    message:   { type: String, default: '' },
    repeat:    { type: String, enum: ['once','hourly','daily','weekly'], default: 'once' },
    nextRun:   { type: Date, default: null },
    active:    { type: Boolean, default: true },
    embed:     { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
  });
  return mongoose.model('Schedule', scheduleSchema);
}

module.exports = {
  getScheduleModel,
};
