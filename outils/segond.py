"""Résolution d'une référence (« Jean 14.6 ») vers le texte Segond 1910
embarqué dans lire/data/. Sert à FABRIQUER les questions à partir du texte
réel, et à vérifier ensuite que chaque citation s'y trouve mot pour mot."""
import json, glob, os, re, unicodedata

RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
LIVRES = {}

def _clef(nom):
    s = unicodedata.normalize('NFD', nom.lower())
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-z0-9]', '', s)

for chemin in glob.glob(os.path.join(RACINE, 'lire', 'data', '*.json')):
    d = json.load(open(chemin, encoding='utf-8'))
    LIVRES[_clef(d['livre'])] = d['chapitres']

# Quelques usages courants qui ne sont pas le nom exact du fichier.
ALIAS = {'psaume': 'psaumes', 'cantique': 'cantiquedescantiques',
         'apocalypsedejean': 'apocalypse', 'lamentationsdejeremie': 'lamentations'}

REF = re.compile(r'^\s*(.+?)\s+(\d+)[.:](\d+)(?:-(\d+))?\s*$')
# Abdias, Philémon, Jude, 2 et 3 Jean n'ont qu'un chapitre : on les cite « Jude 3 »
# et non « Jude 1.3 ». Sans cette forme, ces références passaient pour absentes.
REF_UN_CHAPITRE = re.compile(r'^\s*(.+?)\s+(\d+)(?:-(\d+))?\s*$')

def verset(ref):
    """Texte exact de la référence, ou None si elle n'existe pas."""
    m = REF.match(ref)
    if not m:
        m2 = REF_UN_CHAPITRE.match(ref or '')
        k2 = ALIAS.get(_clef(m2.group(1)), _clef(m2.group(1))) if m2 else None
        if k2 in LIVRES and len(LIVRES[k2]) == 1:
            livre, ch, v1, v2 = m2.group(1), 1, int(m2.group(2)), m2.group(3)
            return _extrait(livre, ch, v1, v2)
        return None
    livre, ch, v1, v2 = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4)
    return _extrait(livre, ch, v1, v2)

def _extrait(livre, ch, v1, v2):
    k = _clef(livre)
    k = ALIAS.get(k, k)
    if k not in LIVRES:
        return None
    chapitres = LIVRES[k]
    if not (1 <= ch <= len(chapitres)):
        return None
    versets = chapitres[ch - 1]
    fin = int(v2) if v2 else v1
    if not (1 <= v1 <= len(versets)) or fin > len(versets):
        return None
    return ' '.join(versets[v1 - 1:fin])

def livre_existe(ref):
    """Vrai si la référence désigne au moins un livre connu, même sans verset
       précis : « Daniel 6 », « Exode 7 à 12 », « Livre d'Esther », « 1, 2 et
       3 Jean ». Une question sur un récit entier n'a pas de citation à
       confronter, mais son livre doit exister."""
    # On découpe aussi sur l'apostrophe : « Livre d'Esther » doit livrer
    # « Esther », sans quoi le livre passe pour inconnu.
    mots = [m for m in re.split(r"[\s,'’]+", (ref or '').strip()) if m]
    fenetres = []
    for i in range(len(mots)):
        for j in range(i + 1, min(i + 4, len(mots)) + 1):
            fenetres.append(' '.join(mots[i:j]))
    for f in fenetres:
        k = _clef(f)
        if k and ALIAS.get(k, k) in LIVRES:
            return True
    return False

def normalise(t):
    """Comparaison tolérante : casse, accents, apostrophes, ponctuation."""
    t = unicodedata.normalize('NFD', (t or '').lower())
    t = ''.join(c for c in t if unicodedata.category(c) != 'Mn')
    t = t.replace('’', "'").replace('œ', 'oe').replace('æ', 'ae')
    return re.sub(r'[^a-z0-9\']+', ' ', t).strip()

def contient(ref, extrait):
    """Vrai si l'extrait figure mot pour mot dans le verset cité. Une citation
       peut élider son milieu par « … » : chaque fragment est alors cherché
       à son tour, dans l'ordre, ce qui interdit de recoller deux morceaux
       venus de versets différents."""
    src = verset(ref)
    if src is None:
        return False
    n = normalise(src)
    pos = 0
    for frag in (f for f in re.split(r'\s*(?:…|\.\.\.)\s*', extrait or '') if f.strip()):
        i = n.find(normalise(frag), pos)
        if i < 0:
            return False
        pos = i + len(normalise(frag))
    return True

# ---- Recherche plein texte sur les 66 livres -------------------------------
# Sert surtout aux affirmations « pas écrit » : si la phrase se retrouve
# quelque part dans la Segond, l'item est faux et doit être retiré.
_PLEIN = None

def _plein_texte():
    global _PLEIN
    if _PLEIN is None:
        morceaux = []
        for chapitres in LIVRES.values():
            for versets in chapitres:
                morceaux.extend(versets)
        _PLEIN = normalise(' '.join(morceaux))
    return _PLEIN

def figure_quelque_part(extrait):
    """Vrai si l'extrait apparaît mot pour mot dans la Bible entière."""
    n = normalise(extrait)
    return bool(n) and n in _plein_texte()

def ou_se_trouve(extrait, maxi=3):
    """Références où l'extrait apparaît (pour lever un doute à la main)."""
    n = normalise(extrait)
    trouves = []
    for clef, chapitres in LIVRES.items():
        for ic, versets in enumerate(chapitres, 1):
            for iv, v in enumerate(versets, 1):
                if n and n in normalise(v):
                    trouves.append(f"{clef} {ic}.{iv}")
                    if len(trouves) >= maxi:
                        return trouves
    return trouves
