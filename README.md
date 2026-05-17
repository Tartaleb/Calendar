# 📅 Mon Agenda

Une page web simple pour consulter et éditer son **Google Agenda jour par jour**,
**sans notion d'heure** : tous les événements sont gérés à la journée.

- 🔐 Connexion avec ton compte Google
- 📆 Navigation jour par jour (précédent / suivant / aujourd'hui / sélecteur de date)
- 🎨 Filtres par couleur (les 11 couleurs de Google Agenda)
- ✏️ Ajout, modification et suppression d'événements
- ☁️ Synchronisé avec ton **vrai** Google Agenda (aucune donnée stockée ailleurs)

> Site statique hébergé sur GitHub Pages. Aucun serveur, aucune base de données :
> tout passe directement entre ton navigateur et l'API Google Agenda.

## Utilisation

1. Ouvre le site : **https://tartaleb.github.io/Calendar/**
2. Au premier lancement, clique sur ⚙️ et colle ton **Client ID OAuth** (voir ci-dessous).
3. Clique sur **Se connecter avec Google** et autorise l'accès à ton agenda.
4. Navigue de jour en jour, filtre par couleur, ajoute/modifie/supprime tes événements.

Le Client ID est mémorisé localement dans ton navigateur — à saisir une seule fois par appareil.

## Configuration Google Cloud

Pour que l'app puisse parler à ton Google Agenda, il faut créer un **ID client OAuth**
gratuit dans Google Cloud. C'est une opération unique, ~5 minutes.

1. **Crée un projet** sur [console.cloud.google.com](https://console.cloud.google.com/)
   → menu *Sélectionner un projet* → *Nouveau projet* (ex. nom : « Mon Agenda »).

2. **Active l'API Google Calendar**
   → *API et services* → *Bibliothèque* → cherche **Google Calendar API** → **Activer**.

3. **Écran de consentement OAuth**
   → *API et services* → *Écran de consentement OAuth*
   → Type **Externe** → renseigne le nom de l'app et ton e-mail
   → dans **Utilisateurs tests**, ajoute **ton adresse Gmail**
   (indispensable tant que l'app reste en mode test).

4. **Crée l'ID client OAuth**
   → *API et services* → *Identifiants* → *Créer des identifiants*
   → **ID client OAuth** → type d'application : **Application Web**
   → dans **Origines JavaScript autorisées**, ajoute exactement :

   | Origine | Pour |
   |---|---|
   | `https://tartaleb.github.io` | le site en ligne |
   | `http://localhost:8000` | tests en local (optionnel) |

   → **Créer**. Copie l'**ID client** (`xxxxxxxx.apps.googleusercontent.com`).

5. **Dans l'app**, clique sur ⚙️, colle l'ID client, **Enregistre**, puis connecte-toi.

> ℹ️ Tant que l'application est en mode « test », Google peut afficher un écran
> « Application non validée » : clique sur *Paramètres avancés* → *Continuer*.
> Seuls les comptes ajoutés en **utilisateurs tests** pourront se connecter.

## Développement local

Servir le dossier avec n'importe quel serveur statique (l'origine doit être
déclarée dans les *Origines JavaScript autorisées*) :

```bash
python -m http.server 8000
# puis http://localhost:8000
```

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page |
| `style.css` | Styles |
| `app.js` | Logique : OAuth Google, API Agenda, rendu, filtres, édition |

## Confidentialité

Aucune donnée n'est envoyée ailleurs que vers les serveurs Google. Le code est
public mais **tes événements ne sont pas dans ce dépôt** : ils restent dans ton
Google Agenda. Le jeton d'accès vit uniquement en mémoire (perdu à la fermeture
de l'onglet).
