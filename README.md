# streamlink-ui

Application web Node.js pour planifier des enregistrements Twitch avec Streamlink.

## Fonctionnalités

- Formulaire sans authentification avec:
  - URL du stream
  - qualité (`best`, `720p`, etc.)
  - plage horaire optionnelle (`début` / `fin`)
- Si aucune plage horaire n'est fournie, l'application surveille en continu et relance automatiquement l'enregistrement pour capter tous les lives du stream.
- Liste des programmations d'enregistrement sur la page principale.
- Deuxième page pour lister les fichiers d'enregistrement générés.
- UI simple avec **HTMX** + **PicoCSS**.

## Lancer en local

Prérequis: `streamlink` installé sur la machine.

```bash
npm install
npm start
```

Puis ouvrir `http://localhost:3000`.

## Lancer avec Docker

```bash
docker compose up --build
```

Puis ouvrir `http://localhost:3000`.
Les fichiers enregistrés sont persistés dans `./recordings`.
