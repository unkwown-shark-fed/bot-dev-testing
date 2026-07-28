'use strict';

const mongoose = require('mongoose');

// ── Connection ────────────────────────────────────────────────────────────────
let _connected = false;

async function connect() {
  if (_connected) return;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in .env');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  _connected = true;
  console.log('[DB] Connected to MongoDB Atlas');
}

mongoose.connection.on('disconnected', () => {
  _connected = false;
  console.warn('[DB] Disconnected — will reconnect on next operation');
});

// ── Schema ────────────────────────────────────────────────────────────────────
const commandSchema = new mongoose.Schema({
  name:         { type: String, required: true, unique: true, lowercase: true, trim: true },
  description:  { type: String, default: 'No description' },
  source:       { type: String, enum: ['file', 'dashboard'], default: 'dashboard' },
  flow:         { type: mongoose.Schema.Types.Mixed, default: null },
  code:         { type: String, default: '' },
  registered:   { type: Boolean, default: false },
  registeredAt: { type: Date,    default: null },
  usageCount:   { type: Number,  default: 0 },
  errorCount:   { type: Number,  default: 0 },
  lastUsedAt:   { type: Date,    default: null },
  createdAt:    { type: Date,    default: Date.now },
  updatedAt:    { type: Date,    default: Date.now },
});

const Command = mongoose.models.Command || mongoose.model('Command', commandSchema);

// ── Member snapshot schema (daily member-count history, used by /membertrend) ─
const memberSnapshotSchema = new mongoose.Schema({
  guildId:     { type: String, required: true },
  dateKey:     { type: String, required: true }, // YYYY-MM-DD (UTC)
  memberCount: { type: Number, required: true },
  recordedAt:  { type: Date, default: Date.now },
});
memberSnapshotSchema.index({ guildId: 1, dateKey: 1 }, { unique: true });

const MemberSnapshot = mongoose.models.MemberSnapshot || mongoose.model('MemberSnapshot', memberSnapshotSchema);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getAllCommands() {
  await connect();
  return Command.find().sort({ source: 1, name: 1 }).lean();
}

async function getCommand(name) {
  await connect();
  return Command.findOne({ name: name.toLowerCase() }).lean();
}

async function upsertCommand(name, data) {
  await connect();
  return Command.findOneAndUpdate(
    { name: name.toLowerCase() },
    { ...data, updatedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function deleteCommand(name) {
  await connect();
  return Command.deleteOne({ name: name.toLowerCase() });
}

async function incrementUsage(name) {
  await connect();
  return Command.updateOne(
    { name: name.toLowerCase() },
    { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
  );
}

async function incrementError(name) {
  await connect();
  return Command.updateOne(
    { name: name.toLowerCase() },
    { $inc: { errorCount: 1 } }
  );
}

// Sync all file-based commands into DB
async function syncFileCommands(commandsArray) {
  await connect();
  const now = new Date();
  for (const cmd of commandsArray) {
    const nameLower = cmd.name.toLowerCase();
    const existing  = await Command.findOne({ name: nameLower }).lean();

    if (!existing) {
      await Command.findOneAndUpdate(
        { name: nameLower },
        {
          $setOnInsert: {
            name:         nameLower,
            description:  cmd.description || '',
            source:       'file',
            code:         '',
            flow:         null,
            registered:   true,
            registeredAt: now,
            usageCount:   0,
            errorCount:   0,
            lastUsedAt:   null,
            createdAt:    now,
            updatedAt:    now,
          }
        },
        { upsert: true, new: true }
      );
    } else if (existing.source === 'file') {
      await Command.updateOne(
        { name: nameLower },
        { $set: { description: cmd.description || '', updatedAt: now } }
      );
    }
  }
}

// Record (or refresh) today's member-count snapshot for a guild.
async function recordMemberSnapshot(guildId, memberCount, dateKey = null) {
  await connect();
  const key = dateKey || new Date().toISOString().slice(0, 10);
  return MemberSnapshot.findOneAndUpdate(
    { guildId, dateKey: key },
    { $set: { memberCount, recordedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

// Fetch stored snapshots for a guild between two dateKeys (inclusive), ascending by date.
async function getMemberSnapshots(guildId, fromDateKey, toDateKey) {
  await connect();
  return MemberSnapshot.find({
    guildId,
    dateKey: { $gte: fromDateKey, $lte: toDateKey },
  }).sort({ dateKey: 1 }).lean();
}

module.exports = {
  connect,
  Command,
  MemberSnapshot,
  getAllCommands,
  getCommand,
  upsertCommand,
  deleteCommand,
  incrementUsage,
  incrementError,
  syncFileCommands,
  recordMemberSnapshot,
  getMemberSnapshots,
};