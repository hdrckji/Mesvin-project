/* ============================================================================
   Bible Horizon — « Signaler », le geste partagé.

   Une église publie des annonces, des rendez-vous, des séries de questions,
   lus par ses membres. Google Play exige alors deux choses : un moyen de
   signaler un contenu DEPUIS l'application, et une modération derrière. La
   modération existe (retrait sur signalement, jamais a priori) ; ce fichier
   est le premier point — le même bouton et le même petit formulaire partout
   où un contenu d'église se voit : la page de l'église (annonces, rendez-vous)
   et les trois épreuves (la série choisie).

   Trois partis pris :
   - SANS COMPTE. L'exiger reviendrait à ne rien recevoir. Le serveur joint le
     jeton s'il existe, et s'en passe sinon.
   - UN MOTIF EN LISTE COURTE, un commentaire facultatif. Quatre motifs
     suffisent pour que l'administration lise la pile en diagonale ; le texte
     libre est là pour qui veut préciser, et n'est jamais exigé.
   - DISCRET. Un petit drapeau et le mot « Signaler », dans le style des
     liens d'action de la page. Ce n'est pas une invitation à douter, c'est
     une porte de service pour celui qui a vu quelque chose.

   Chargé APRÈS api-client.js. Expose window.BHSignaler :
     bouton(genre, cible, contexte, groupe)  → HTML du bouton
     brancher(racine)                        → un seul écouteur délégué
   Les pages qui en ont besoin en font des rendus à volonté : l'écouteur est
   posé sur la racine, il survit à tous les innerHTML.
   ========================================================================== */
'use strict';

(function () {
  const RAISONS = [
    ['inapproprie', 'Contenu inapproprié'],
    ['spam',        'Spam ou publicité'],
    ['erreur',      'Erreur dans le contenu'],
    ['autre',       'Autre'],
  ];

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* Le drapeau : icons.js le porte quand il est chargé (page principale et
     épreuves) ; sinon un trait équivalent, pour ne jamais dépendre de l'ordre
     des scripts ni d'un cache mélangé pendant une mise à jour. */
  function drapeau() {
    if (typeof window.icon === 'function') {
      try { const h = window.icon('drapeau', 13); if (h) return h; } catch (e) { /* repli */ }
    }
    return '<svg class="icon" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" '
      + 'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M5 17V3.5"/><path d="M5 4h9.5l-2 3.2 2 3.3H5"/></svg>';
  }

  /* Les styles voyagent avec le script : les épreuves n'ont pas app.css, et
     un formulaire doit se ressembler partout. Les variables de la page
     s'appliquent quand elles existent, avec un repli lisible sinon. */
  function poserStyles() {
    if (document.getElementById('sig-styles')) return;
    const st = document.createElement('style');
    st.id = 'sig-styles';
    st.textContent = `
.sig-btn { background: none; border: 0; font: inherit; font-size: .84rem; color: var(--ink-soft, #6b6b6b);
  cursor: pointer; padding: 6px 4px; text-decoration: underline; text-underline-offset: 3px;
  display: inline-flex; align-items: center; gap: 4px; vertical-align: baseline; }
.sig-btn .icon { opacity: .8; }
.sig-btn[disabled] { cursor: default; text-decoration: none; opacity: .8; }
.sig-btn.sig-fait { color: var(--grow, var(--ok, #4a7c59)); }
.sig-form { margin: 8px 0 4px; padding: 12px 14px; border-radius: 12px;
  border: 1px solid var(--line, rgba(0,0,0,.12)); background: var(--surface-2, rgba(0,0,0,.03)); }
.sig-form .sig-titre { font-weight: 600; font-size: .95rem; margin: 0 0 8px; }
.sig-form .sig-raisons { display: flex; flex-wrap: wrap; gap: 8px; }
.sig-form .sig-raison { border: 1px solid var(--line, rgba(0,0,0,.15)); background: var(--surface, #fff);
  color: var(--ink, #222); border-radius: 12px; padding: 7px 12px; font: inherit; font-size: .9rem; cursor: pointer; }
.sig-form .sig-raison.on { background: var(--grow, #4a7c59); color: var(--on-grow, #fff); border-color: var(--grow, #4a7c59); }
.sig-form textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: .95rem; min-height: 64px;
  margin-top: 10px; padding: 10px 12px; border-radius: 10px; resize: vertical;
  border: 1px solid var(--line, rgba(0,0,0,.15)); background: var(--surface, #fff); color: var(--ink, #222); }
.sig-form .sig-note { font-size: .8rem; color: var(--ink-soft, #6b6b6b); margin: 8px 2px 0; }
.sig-form .sig-actions { display: flex; gap: 10px; margin-top: 10px; }
.sig-form .sig-actions button { flex: 1; font: inherit; font-size: .95rem; padding: 10px 12px; border-radius: 12px;
  cursor: pointer; border: 1px solid transparent; }
.sig-form .sig-envoyer { background: var(--grow, #4a7c59); color: var(--on-grow, #fff); }
.sig-form .sig-annuler { background: transparent; color: var(--ink, #222); border-color: var(--line, rgba(0,0,0,.15)); }
.sig-form button[disabled] { opacity: .6; cursor: default; }
.sig-form .sig-erreur { color: var(--danger, #b3261e); font-size: .88rem; margin: 8px 2px 0; }
.sig-form .sig-merci { margin: 0; font-size: .95rem; }
/* Dans la ligne d'un rendez-vous (flex), le formulaire prend toute la largeur. */
.egl-rdv > .sig-form { flex: 1 0 100%; }
`;
    document.head.appendChild(st);
  }

  /** Le bouton. `groupe` est le code de l'église (null pour un contenu sans église). */
  function bouton(genre, cible, contexte, groupe) {
    return `<button type="button" class="sig-btn" data-signaler="${esc(cible)}" data-genre="${esc(genre)}"`
      + ` data-contexte="${esc(contexte)}" data-groupe="${esc(groupe || '')}"`
      + ` title="Signaler ce contenu">${drapeau()}Signaler</button>`;
  }

  function formulaire() {
    return `<form class="sig-form" data-sigform="1">
      <p class="sig-titre">Qu'est-ce qui pose problème ?</p>
      <div class="sig-raisons">${RAISONS.map(([v, l]) =>
        `<button type="button" class="sig-raison" data-raison="${v}">${l}</button>`).join('')}</div>
      <textarea maxlength="500" placeholder="Un mot pour expliquer (facultatif)"></textarea>
      <p class="sig-note">Aucun compte n'est nécessaire. Seul ce que tu écris ici est envoyé.</p>
      <div class="sig-actions">
        <button type="submit" class="sig-envoyer">Envoyer</button>
        <button type="button" class="sig-annuler" data-sigannuler="1">Annuler</button>
      </div>
      <p class="sig-erreur" hidden></p>
    </form>`;
  }

  /* Le formulaire se pose SOUS le bloc qui porte le bouton : la ligne d'actions
     d'une annonce, celle d'un rendez-vous, le paragraphe de la série. */
  function ouvrir(b) {
    fermerTout();
    const hote = b.closest('[data-sighote]') || b.parentElement;
    const wrap = document.createElement('div');
    wrap.innerHTML = formulaire();
    const form = wrap.firstElementChild;
    form._bouton = b;
    hote.insertAdjacentElement('afterend', form);
    b.setAttribute('aria-expanded', 'true');
    const ta = form.querySelector('textarea');
    // Le premier motif prend le focus : au clavier, tout se fait en trois touches.
    const premier = form.querySelector('.sig-raison');
    if (premier) premier.focus();
    return ta;
  }

  function fermerTout() {
    document.querySelectorAll('form[data-sigform]').forEach(f => {
      if (f._bouton) f._bouton.removeAttribute('aria-expanded');
      f.remove();
    });
  }

  async function envoyer(form) {
    const b = form._bouton;
    const raison = form.querySelector('.sig-raison.on');
    const err = form.querySelector('.sig-erreur');
    if (!raison) {
      err.textContent = 'Choisis un motif — un seul tap suffit.';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    const motif = (form.querySelector('textarea').value || '').trim();
    form.querySelectorAll('button').forEach(x => { x.disabled = true; });
    const envoyerBtn = form.querySelector('.sig-envoyer');
    envoyerBtn.textContent = 'Envoi…';
    try {
      await GraineAPI.signaler(b.dataset.genre, b.dataset.signaler, b.dataset.contexte || '', motif,
        { raison: raison.dataset.raison, groupe: b.dataset.groupe || undefined });
      form.innerHTML = `<p class="sig-merci">Signalé, merci ✓ — quelqu'un va regarder.</p>`;
      if (b) {
        b.disabled = true;
        b.classList.add('sig-fait');
        b.innerHTML = `${drapeau()}Signalé ✓`;
      }
      setTimeout(() => { if (form.isConnected) form.remove(); }, 4000);
    } catch (e) {
      /* Hors-ligne, ou plafond atteint : on le dit sans dramatiser, et on
         redonne la main. Un signalement perdu n'est jamais grave ; un lecteur
         qui croit avoir signalé alors que non, si. */
      form.querySelectorAll('button').forEach(x => { x.disabled = false; });
      envoyerBtn.textContent = 'Envoyer';
      err.textContent = e && e.offline
        ? 'Pas de connexion — réessaie une fois revenu en ligne.'
        : ((e && e.message) || 'Le signalement n\'est pas parti. Réessaie plus tard.');
      err.hidden = false;
    }
  }

  /** Un seul écouteur délégué sur la racine : il survit à tous les rendus. */
  function brancher(racine) {
    if (!racine || racine._sigBranche) return;
    racine._sigBranche = true;
    poserStyles();
    racine.addEventListener('click', ev => {
      const b = ev.target.closest('[data-signaler]');
      if (b && !b.disabled && racine.contains(b)) {
        if (b.getAttribute('aria-expanded') === 'true') fermerTout();
        else ouvrir(b);
        return;
      }
      const r = ev.target.closest('.sig-raison');
      if (r) {
        const form = r.closest('form[data-sigform]');
        form.querySelectorAll('.sig-raison').forEach(x => x.classList.toggle('on', x === r));
        const err = form.querySelector('.sig-erreur'); if (err) err.hidden = true;
        return;
      }
      if (ev.target.closest('[data-sigannuler]')) { fermerTout(); }
    });
    racine.addEventListener('submit', ev => {
      const form = ev.target.closest('form[data-sigform]');
      if (!form) return;
      ev.preventDefault();
      envoyer(form);
    });
  }

  window.BHSignaler = { bouton, brancher, RAISONS };
})();
