export const jobs = new Map();

function now() {
  return new Date().toISOString();
}

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
  jobs.set(jobId, job);
  return job;
}

export function updateProgress(jobId, progress) {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.progress = progress;
  job.updatedAt = now();
  jobs.set(jobId, job);
  return job;
}

export function setJobResult(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.result = result;
  job.updatedAt = now();
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}
