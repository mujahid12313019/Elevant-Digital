export const jobs = new Map();

const JOB_RETENTION_MS = 1000 * 60 * 60; // 1 hour
const CLEANUP_INTERVAL_MS = 1000 * 60 * 5; // 5 minutes

function now() {
  return new Date().toISOString();
}

// Cleanup old jobs every 5 minutes
setInterval(() => {
  const now_ms = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now_ms - new Date(job.updatedAt).getTime() > JOB_RETENTION_MS) {
      jobs.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

export function createJob(jobId, initial = {}) {
  const job = {
    id: jobId,
    status: initial.status || "queued",
    progress: initial.progress || 0,
    message: initial.message || null,
    createdAt: now(),
    updatedAt: now(),
    result: null,
  };
  jobs.set(jobId, job);
  return job;
}

export function updateStatus(jobId, status, message) {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.status = status;
  if (message) job.message = message;
  job.updatedAt = now();
  return job;
}

export function updateProgress(jobId, progress) {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.progress = Math.min(100, Math.max(0, progress));
  job.updatedAt = now();
  return job;
}

export function setJobResult(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.result = result;
  job.updatedAt = now();
  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}
