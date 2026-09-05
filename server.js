const express = require('express');
const rateLimit = require('express-rate-limit');
const escapeHtml = require('escape-html');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.set('trust proxy', 1);

const port = Number(process.env.PORT || 3000);
const recordingsDir = path.join(__dirname, 'recordings');
const viewsDir = path.join(__dirname, 'views');
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'app.db');

const restartDelayMs = 5000;
const schedulerTickMs = 10000;

fs.mkdirSync(recordingsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const templates = {
  layout: fs.readFileSync(path.join(viewsDir, 'layout.html'), 'utf8'),
  index: fs.readFileSync(path.join(viewsDir, 'index.html'), 'utf8'),
  schedulesSection: fs.readFileSync(path.join(viewsDir, 'schedules-section.html'), 'utf8'),
  recordings: fs.readFileSync(path.join(viewsDir, 'recordings.html'), 'utf8')
};

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    quality TEXT NOT NULL,
    start_at TEXT,
    end_at TEXT,
    continuous INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const insertScheduleStmt = db.prepare(`
  INSERT INTO schedules (id, url, quality, start_at, end_at, continuous, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateStatusStmt = db.prepare(`
  UPDATE schedules
  SET status = ?, updated_at = ?
  WHERE id = ?
`);

const deleteScheduleStmt = db.prepare(`
  DELETE FROM schedules
  WHERE id = ?
`);

const selectSchedulesStmt = db.prepare(`
  SELECT id, url, quality, start_at, end_at, continuous, status, created_at, updated_at
  FROM schedules
  ORDER BY created_at DESC
`);

const schedules = selectSchedulesStmt.all().map((row) => ({
  id: row.id,
  url: row.url,
  quality: row.quality,
  startAt: parseDateTime(row.start_at),
  endAt: parseDateTime(row.end_at),
  continuous: Boolean(row.continuous),
  status: row.status,
  createdAt: parseDateTime(row.created_at),
  updatedAt: parseDateTime(row.updated_at),
  startTimer: null,
  stopTimer: null,
  restartTimer: null,
  process: null,
  deleted: false
}));

app.use(express.urlencoded({ extended: false }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120
  })
);

function fillTemplate(template, values) {
  return template.replace(/\{\{\s*([a-zA-Z0-9]+)\s*\}\}/g, (_, key) => values[key] ?? '');
}

function formatDate(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function getStreamName(url) {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, '');
    const streamName = pathname.split('/').pop();
    return streamName || 'stream';
  } catch {
    return 'stream';
  }
}

function sanitizeFileNamePart(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[-_.]+|[-_.]+$/g, '') || 'stream';
}

function renderLayout(title, content) {
  return fillTemplate(templates.layout, {
    title: escapeHtml(title),
    content
  });
}

function renderSchedulesSection(message, isError) {
  const notice = message
    ? `<article class="${isError ? 'contrast' : ''}">${escapeHtml(message)}</article>`
    : '';

  const rows = schedules
    .map((schedule) => `<tr>
        <td><code>${escapeHtml(schedule.id)}</code></td>
        <td>${escapeHtml(schedule.url)}</td>
        <td>${escapeHtml(schedule.quality)}</td>
        <td>${formatDate(schedule.startAt)}</td>
        <td>${formatDate(schedule.endAt)}</td>
        <td>${escapeHtml(schedule.status)}</td>
        <td>
          <form method="post" action="/schedules/${escapeHtml(schedule.id)}/stop" hx-post="/schedules/${escapeHtml(schedule.id)}/stop" hx-target="#schedules-section" hx-swap="outerHTML" style="display: inline-block;">
            <button type="submit" ${schedule.status === 'stopped' || schedule.status === 'completed' ? 'disabled' : ''}>Arrêter</button>
          </form>
          <form method="post" action="/schedules/${escapeHtml(schedule.id)}/delete" hx-post="/schedules/${escapeHtml(schedule.id)}/delete" hx-target="#schedules-section" hx-swap="outerHTML" style="display: inline-block;">
            <button type="submit" class="secondary" onclick="return confirm('Supprimer cette programmation ?');">Supprimer</button>
          </form>
        </td>
      </tr>`)
    .join('') || '<tr><td colspan="7">Aucune programmation pour le moment.</td></tr>';

  return fillTemplate(templates.schedulesSection, {
    notice,
    rows
  });
}

function setScheduleStatus(schedule, status) {
  schedule.status = status;
  schedule.updatedAt = new Date();
  updateStatusStmt.run(status, schedule.updatedAt.toISOString(), schedule.id);
}

function shouldRetry(schedule) {
  if (schedule.continuous && !schedule.endAt) {
    return true;
  }

  if (schedule.endAt && schedule.endAt.getTime() > Date.now()) {
    return true;
  }

  return false;
}

function clearScheduleTimers(schedule) {
  if (schedule.startTimer) {
    clearTimeout(schedule.startTimer);
    schedule.startTimer = null;
  }

  if (schedule.stopTimer) {
    clearTimeout(schedule.stopTimer);
    schedule.stopTimer = null;
  }

  if (schedule.restartTimer) {
    clearTimeout(schedule.restartTimer);
    schedule.restartTimer = null;
  }
}

function startRecording(schedule) {
  if (schedule.process) {
    return;
  }

  if (schedule.endAt && schedule.endAt.getTime() <= Date.now()) {
    setScheduleStatus(schedule, 'completed');
    return;
  }

  clearScheduleTimers(schedule);

  const now = new Date();
  const streamName = sanitizeFileNamePart(getStreamName(schedule.url));
  const timestamp = now.toISOString().replace('T', '_').replaceAll(':', '-');
  const fileName = `${streamName}-${timestamp}.mp4`;
  const outputPath = path.join(recordingsDir, fileName);

  setScheduleStatus(schedule, 'recording');
  console.log(`[recording] Démarrage ${schedule.id} (${schedule.url})`);

  const args = [schedule.url, schedule.quality, '-o', outputPath];
  const child = spawn('streamlink', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  schedule.process = child;

  child.stderr.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      console.error(`[recording:${schedule.id}] ${message}`);
    }
  });

  child.on('error', (error) => {
    if (schedule.deleted || schedule.status === 'stopped') {
      return;
    }

    console.error(`[recording] Erreur lancement ${schedule.id}: ${error.message}`);
    schedule.process = null;

    if (shouldRetry(schedule)) {
      setScheduleStatus(schedule, 'waiting-next-live');
      schedule.restartTimer = setTimeout(() => {
        schedule.restartTimer = null;
        startRecording(schedule);
      }, restartDelayMs);
      return;
    }

    setScheduleStatus(schedule, 'failed');
  });

  child.on('close', (code) => {
    schedule.process = null;

    if (schedule.deleted) {
      return;
    }

    console.log(`[recording] Fin ${schedule.id} code=${code}`);

    if (schedule.status === 'stopped') {
      return;
    }

    if (shouldRetry(schedule)) {
      setScheduleStatus(schedule, 'waiting-next-live');
      schedule.restartTimer = setTimeout(() => {
        schedule.restartTimer = null;
        startRecording(schedule);
      }, restartDelayMs);
      return;
    }

    setScheduleStatus(schedule, code === 0 ? 'completed' : 'failed');
  });

  if (schedule.endAt) {
    const delay = schedule.endAt.getTime() - Date.now();
    if (delay > 0) {
      schedule.stopTimer = setTimeout(() => {
        schedule.stopTimer = null;
        if (schedule.process) {
          setScheduleStatus(schedule, 'completed');
          schedule.process.kill('SIGTERM');
        }
      }, delay);
    }
  }
}

function queueSchedule(schedule) {
  if (schedule.process) {
    return;
  }

  if (schedule.endAt && schedule.endAt.getTime() <= Date.now()) {
    setScheduleStatus(schedule, 'completed');
    return;
  }

  if (!schedule.startAt || schedule.startAt.getTime() <= Date.now()) {
    startRecording(schedule);
    return;
  }

  if (!schedule.startTimer) {
    setScheduleStatus(schedule, 'scheduled');
    schedule.startTimer = setTimeout(() => {
      schedule.startTimer = null;
      startRecording(schedule);
    }, schedule.startAt.getTime() - Date.now());
  }
}

function schedulerTick() {
  for (const schedule of schedules) {
    if (schedule.process || schedule.startTimer || schedule.restartTimer) {
      continue;
    }

    if (schedule.endAt && schedule.endAt.getTime() <= Date.now()) {
      if (schedule.status !== 'completed') {
        setScheduleStatus(schedule, 'completed');
      }
      continue;
    }

    if (schedule.status === 'completed' || schedule.status === 'stopped') {
      continue;
    }

    if (schedule.status === 'scheduled' && schedule.startAt && schedule.startAt.getTime() > Date.now()) {
      continue;
    }

    queueSchedule(schedule);
  }
}

function stopSchedule(schedule) {
  clearScheduleTimers(schedule);
  setScheduleStatus(schedule, 'stopped');

  if (schedule.process) {
    schedule.process.kill('SIGTERM');
  }
}

function parseDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

app.get('/', (req, res) => {
  const content = fillTemplate(templates.index, {
    schedulesSection: renderSchedulesSection()
  });

  res.type('html').send(renderLayout('Programmations', content));
});

app.post('/schedules', (req, res) => {
  const url = String(req.body.url || '').trim();
  const quality = String(req.body.quality || 'best').trim() || 'best';
  const startAt = parseDateTime(req.body.startAt);
  const endAt = parseDateTime(req.body.endAt);

  const htmxRequest = req.get('HX-Request') === 'true';

  if (!url) {
    const html = renderSchedulesSection("L'URL du stream est obligatoire.", true);
    return htmxRequest ? res.status(422).type('html').send(html) : res.status(422).send("L'URL du stream est obligatoire.");
  }

  if (req.body.startAt && !startAt) {
    const html = renderSchedulesSection('La date de début est invalide.', true);
    return htmxRequest ? res.status(422).type('html').send(html) : res.status(422).send('La date de début est invalide.');
  }

  if (req.body.endAt && !endAt) {
    const html = renderSchedulesSection('La date de fin est invalide.', true);
    return htmxRequest ? res.status(422).type('html').send(html) : res.status(422).send('La date de fin est invalide.');
  }

  if (endAt && !startAt) {
    const html = renderSchedulesSection('Renseignez une date de début pour utiliser une date de fin.', true);
    return htmxRequest ? res.status(422).type('html').send(html) : res.status(422).send('Renseignez une date de début pour utiliser une date de fin.');
  }

  if (startAt && endAt && endAt.getTime() <= startAt.getTime()) {
    const html = renderSchedulesSection('La date de fin doit être après la date de début.', true);
    return htmxRequest ? res.status(422).type('html').send(html) : res.status(422).send('La date de fin doit être après la date de début.');
  }

  const now = new Date();
  const schedule = {
    id: randomUUID(),
    url,
    quality,
    startAt,
    endAt,
    continuous: !startAt && !endAt,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    startTimer: null,
    stopTimer: null,
    restartTimer: null,
    process: null,
    deleted: false
  };

  insertScheduleStmt.run(
    schedule.id,
    schedule.url,
    schedule.quality,
    schedule.startAt ? schedule.startAt.toISOString() : null,
    schedule.endAt ? schedule.endAt.toISOString() : null,
    schedule.continuous ? 1 : 0,
    schedule.status,
    schedule.createdAt.toISOString(),
    schedule.updatedAt.toISOString()
  );

  schedules.unshift(schedule);
  queueSchedule(schedule);

  const html = renderSchedulesSection('Programmation ajoutée.');
  return htmxRequest ? res.type('html').send(html) : res.redirect('/');
});

app.post('/schedules/:id/stop', (req, res) => {
  const schedule = schedules.find((item) => item.id === req.params.id);
  const htmxRequest = req.get('HX-Request') === 'true';

  if (!schedule) {
    return res.status(404).send('Programmation introuvable.');
  }

  stopSchedule(schedule);
  const html = renderSchedulesSection('Programmation arrêtée.');
  return htmxRequest ? res.type('html').send(html) : res.redirect('/');
});

app.post('/schedules/:id/delete', (req, res) => {
  const scheduleIndex = schedules.findIndex((item) => item.id === req.params.id);
  const htmxRequest = req.get('HX-Request') === 'true';

  if (scheduleIndex === -1) {
    return res.status(404).send('Programmation introuvable.');
  }

  const [schedule] = schedules.splice(scheduleIndex, 1);
  schedule.deleted = true;
  clearScheduleTimers(schedule);
  if (schedule.process) {
    schedule.process.kill('SIGTERM');
  }
  deleteScheduleStmt.run(schedule.id);

  const html = renderSchedulesSection('Programmation supprimée.');
  return htmxRequest ? res.type('html').send(html) : res.redirect('/');
});

app.get('/recordings', async (req, res, next) => {
  try {
    const entries = await fs.promises.readdir(recordingsDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const fullPath = path.join(recordingsDir, entry.name);
          const stat = await fs.promises.stat(fullPath);
          return {
            name: entry.name,
            size: stat.size,
            modifiedAt: stat.mtime
          };
        })
    );

    files.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

    const rows = files
      .map((file) => `<tr>
        <td>${escapeHtml(file.name)}</td>
        <td>${(file.size / (1024 * 1024)).toFixed(2)} Mo</td>
        <td>${formatDate(file.modifiedAt)}</td>
      </tr>`)
      .join('') || '<tr><td colspan="3">Aucun fichier enregistré.</td></tr>';

    const content = fillTemplate(templates.recordings, { rows });

    res.type('html').send(renderLayout('Enregistrements', content));
  } catch (error) {
    next(error);
  }
});

for (const schedule of schedules) {
  queueSchedule(schedule);
}

setInterval(schedulerTick, schedulerTickMs);

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
