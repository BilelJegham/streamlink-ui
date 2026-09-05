const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const app = express();
const port = Number(process.env.PORT || 3000);
const recordingsDir = path.join(__dirname, 'recordings');
const schedules = [];

fs.mkdirSync(recordingsDir, { recursive: true });

app.use(express.urlencoded({ extended: false }));

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function renderLayout(title, content) {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css" />
    <script src="https://unpkg.com/htmx.org@2.0.6"></script>
  </head>
  <body>
    <main class="container">
      <nav>
        <ul><li><strong>Streamlink UI</strong></li></ul>
        <ul>
          <li><a href="/">Programmations</a></li>
          <li><a href="/recordings">Enregistrements</a></li>
        </ul>
      </nav>
      ${content}
    </main>
  </body>
</html>`;
}

function renderSchedulesSection(message, isError) {
  const notice = message
    ? `<article class="${isError ? 'contrast' : ''}">${escapeHtml(message)}</article>`
    : '';

  const rows = schedules
    .map((schedule) => {
      return `<tr>
        <td><code>${escapeHtml(schedule.id)}</code></td>
        <td>${escapeHtml(schedule.url)}</td>
        <td>${escapeHtml(schedule.quality)}</td>
        <td>${formatDate(schedule.startAt)}</td>
        <td>${formatDate(schedule.endAt)}</td>
        <td>${escapeHtml(schedule.status)}</td>
      </tr>`;
    })
    .join('');

  return `
<section id="schedules-section">
  ${notice}
  <h2>Programmations d'enregistrement</h2>
  <figure>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>URL</th>
          <th>Qualité</th>
          <th>Début</th>
          <th>Fin</th>
          <th>Statut</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="6">Aucune programmation pour le moment.</td></tr>'}
      </tbody>
    </table>
  </figure>
</section>`;
}

function startRecording(schedule) {
  const now = new Date();
  const fileName = `${schedule.id}-${now.toISOString().replaceAll(':', '-')}.ts`;
  const outputPath = path.join(recordingsDir, fileName);

  schedule.status = 'recording';

  const args = [
    schedule.url,
    schedule.quality,
    '-o',
    outputPath,
    '--retry-streams',
    '30'
  ];

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
  const content = `
<h1>Planifier un enregistrement Twitch</h1>
<p>Sans authentification: indiquez l'URL du stream, la qualité et une plage horaire facultative.</p>
<form method="post" action="/schedules" hx-post="/schedules" hx-target="#schedules-section" hx-swap="outerHTML">
  <label>
    URL du stream
    <input type="url" name="url" placeholder="https://www.twitch.tv/nom_du_stream" required />
  </label>
  <label>
    Qualité
    <input type="text" name="quality" value="best" required />
  </label>
  <fieldset class="grid">
    <label>
      Début (optionnel)
      <input type="datetime-local" name="startAt" />
    </label>
    <label>
      Fin (optionnel)
      <input type="datetime-local" name="endAt" />
    </label>
  </fieldset>
  <button type="submit">Ajouter la programmation</button>
</form>
${renderSchedulesSection()}`;

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
    status: 'pending',
    startTimer: null,
    stopTimer: null,
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
      .join('');

    const content = `
<h1>Fichiers d'enregistrements</h1>
<figure>
  <table>
    <thead>
      <tr>
        <th>Nom</th>
        <th>Taille</th>
        <th>Dernière modification</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="3">Aucun fichier enregistré.</td></tr>'}
    </tbody>
  </table>
</figure>`;

    res.type('html').send(renderLayout('Enregistrements', content));
  } catch (error) {
    next(error);
  }
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
