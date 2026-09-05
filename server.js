const express = require('express');
const rateLimit = require('express-rate-limit');
const escapeHtml = require('escape-html');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const app = express();
const port = Number(process.env.PORT || 3000);
const recordingsDir = path.join(__dirname, 'recordings');
const viewsDir = path.join(__dirname, 'views');
const schedules = [];
const restartDelayMs = 5000;

const templates = {
  layout: fs.readFileSync(path.join(viewsDir, 'layout.html'), 'utf8'),
  index: fs.readFileSync(path.join(viewsDir, 'index.html'), 'utf8'),
  schedulesSection: fs.readFileSync(path.join(viewsDir, 'schedules-section.html'), 'utf8'),
  recordings: fs.readFileSync(path.join(viewsDir, 'recordings.html'), 'utf8')
};

fs.mkdirSync(recordingsDir, { recursive: true });

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
      </tr>`)
    .join('') || '<tr><td colspan="6">Aucune programmation pour le moment.</td></tr>';

  return fillTemplate(templates.schedulesSection, {
    notice,
    rows
  });
}

function startRecording(schedule) {
  const now = new Date();
  const fileName = `${schedule.id}-${now.toISOString().replaceAll(':', '-')}.ts`;
  const outputPath = path.join(recordingsDir, fileName);

  schedule.status = 'recording';

  const args = [schedule.url, schedule.quality, '-o', outputPath];
  const child = spawn('streamlink', args, { stdio: 'ignore' });
  schedule.process = child;

  child.on('error', () => {
    schedule.status = 'failed';
    schedule.process = null;
  });

  child.on('close', (code) => {
    schedule.process = null;
    if (schedule.status === 'stopped') {
      schedule.status = 'completed';
      return;
    }

    if (schedule.continuous && !schedule.endAt) {
      schedule.status = 'waiting-next-live';
      schedule.restartTimer = setTimeout(() => {
        startRecording(schedule);
      }, restartDelayMs);
      return;
    }

    schedule.status = code === 0 ? 'completed' : 'failed';
  });

  if (schedule.endAt) {
    const delay = schedule.endAt.getTime() - Date.now();
    if (delay > 0) {
      schedule.stopTimer = setTimeout(() => {
        if (schedule.process) {
          schedule.status = 'stopped';
          schedule.process.kill('SIGTERM');
        }
      }, delay);
    }
  }
}

function queueSchedule(schedule) {
  if (!schedule.startAt || schedule.startAt.getTime() <= Date.now()) {
    startRecording(schedule);
    return;
  }

  schedule.status = 'scheduled';
  schedule.startTimer = setTimeout(() => {
    startRecording(schedule);
  }, schedule.startAt.getTime() - Date.now());
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

  const schedule = {
    id: randomUUID(),
    url,
    quality,
    startAt,
    endAt,
    continuous: !startAt && !endAt,
    status: 'pending',
    startTimer: null,
    stopTimer: null,
    restartTimer: null,
    process: null
  };

  schedules.unshift(schedule);
  queueSchedule(schedule);

  const html = renderSchedulesSection('Programmation ajoutée.');
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

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
