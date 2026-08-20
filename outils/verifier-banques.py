# -*- coding: utf-8 -*-
"""Contrôle complet des banques d'épreuves contre la Segond embarquée.
À relancer après toute modification de contenu."""
import sys, json, io, re, collections; sys.path.insert(0, 'outils')
import segond

souci = 0

def charge(chemin):
    return json.load(io.open(chemin, encoding='utf-8'))['items']

# --- structure commune -----------------------------------------------------
for nom, chemin in [("Qui a dit ça ?", 'quiadit/data/banque.json'),
                    ("Écrit… ou pas ?", 'ecritoupas/data/banque.json'),
                    ("De qui parle-t-on ?", 'portrait/data/banque.json')]:
    items = charge(chemin)
    ids = [i['id'] for i in items]
    dbl = [k for k, n in collections.Counter(ids).items() if n > 1]
    if dbl:
        print(f"✗ {nom} : identifiants en double {dbl}"); souci += 1

# --- Qui a dit ça ? --------------------------------------------------------
items = charge('quiadit/data/banque.json')
for i in items:
    if not segond.contient(i['reference'], i['parole']):
        print(f"✗ qd {i['id']} : parole absente de {i['reference']}"); souci += 1
    if len(i['options']) != 4 or len(set(i['options'])) != 4:
        print(f"✗ qd {i['id']} : options non uniques ou pas 4"); souci += 1
    if not 0 <= i['bonne'] < 4:
        print(f"✗ qd {i['id']} : index de bonne réponse hors bornes"); souci += 1
print(f"Qui a dit ça ?        {len(items):3d} items")

# --- Écrit… ou pas ? -------------------------------------------------------
items = charge('ecritoupas/data/banque.json')
vrais = faux = 0
for i in items:
    if i['ecrit']:
        vrais += 1
        if not (i.get('reference') and segond.contient(i['reference'], i['phrase'])):
            print(f"✗ eo {i['id']} : « écrit » introuvable à {i.get('reference')}"); souci += 1
    else:
        faux += 1
        if segond.figure_quelque_part(i['phrase']):
            print(f"✗ eo {i['id']} : donné « pas écrit » mais présent en {segond.ou_se_trouve(i['phrase'])}"); souci += 1
print(f"Écrit… ou pas ?       {len(items):3d} items ({vrais} écrits / {faux} pas écrits)")

# --- De qui parle-t-on ? ---------------------------------------------------
items = charge('portrait/data/banque.json')
for i in items:
    if len(i['indices']) != 5:
        print(f"✗ po {i['id']} : {len(i['indices'])} indices au lieu de 5"); souci += 1
    if segond.normalise(i['reponse']) not in [segond.normalise(a) for a in i['accepte']]:
        print(f"✗ po {i['id']} : la réponse « {i['reponse']} » n'est pas dans accepte"); souci += 1
print(f"De qui parle-t-on ?   {len(items):3d} items")

# --- Le Défi : 600 questions -----------------------------------------------
# Longtemps la seule banque à n'être JAMAIS confrontée au texte. Un lecteur y a
# trouvé une question de « Complète le verset » écrite d'après Martin/Darby
# alors que l'appli suit la Segond 1910 : la citation ET la réponse venaient
# d'ailleurs. Ce qui suit rend ce genre d'écart impossible à laisser passer.
questions = json.load(io.open('defi/data/questions.json', encoding='utf-8'))
questions = questions.get('questions', questions)
ids = [q['id'] for q in questions]
dbl = [k for k, n in collections.Counter(ids).items() if n > 1]
if dbl:
    print(f"✗ Défi : identifiants en double {dbl}"); souci += 1

CITATION = re.compile(r'[«"]\s*(.+?)\s*[»"]', re.S)
TROU = re.compile(r'_{2,}')

par_categorie = collections.Counter()
larges = 0
for q in questions:
    ident, ref = q['id'], (q.get('reference') or '')
    par_categorie[q.get('categorie', '?')] += 1

    if len(q.get('options', [])) != 4 or len(set(q['options'])) != 4:
        print(f"✗ défi {ident} : options non uniques ou pas 4"); souci += 1
    if not 0 <= q.get('bonne', -1) < len(q.get('options', [])):
        print(f"✗ défi {ident} : index de bonne réponse hors bornes"); souci += 1

    # Toutes les questions ne citent PAS un verset précis : « Daniel 6 »,
    # « Exode 7 à 12 », « Livre d'Esther » désignent un chapitre ou un livre
    # entier, et c'est légitime pour une question de récit. On vérifie alors
    # que le LIVRE existe, sans pouvoir confronter de citation.
    if segond.verset(ref) is None:
        if segond.livre_existe(ref):
            larges += 1
            continue
        print(f"✗ défi {ident} : référence introuvable « {ref} »"); souci += 1
        continue

    bonne = q['options'][q['bonne']]
    citation = CITATION.search(q.get('question', ''))

    # « Complète le verset » : la phrase COMPLÉTÉE doit se lire mot pour mot au
    # verset cité. C'est le contrôle qui aurait arrêté vers-80.
    if TROU.search(q.get('question', '')):
        brut = citation.group(1) if citation else q['question']
        # « peu d' ___ » se lit bien à l'écran mais donne « peu d' ouvriers »
        # une fois recollé : l'espace après l'apostrophe est typographique, il
        # ne doit pas faire échouer la comparaison au texte.
        phrase = re.sub(r"['’]\s+", "'", TROU.sub(bonne, brut)).rstrip(' .!?;:')
        if not segond.contient(ref, phrase):
            print(f"✗ défi {ident} : complétée, la phrase ne se lit pas en {ref}")
            print(f"        attendu ici : {segond.verset(ref)}")
            print(f"        la question : {phrase}")
            souci += 1
    # Toute autre question qui CITE le texte entre guillemets doit citer juste.
    elif citation:
        extrait = citation.group(1).rstrip(' .!?;:')
        if len(segond.normalise(extrait).split()) >= 4 and not segond.contient(ref, extrait):
            print(f"✗ défi {ident} : la citation ne se trouve pas en {ref}")
            print(f"        attendu ici : {segond.verset(ref)}")
            print(f"        la question : {extrait}")
            souci += 1

print(f"Défi                  {len(questions):3d} questions ({larges} à référence large, non confrontables)")
for cat, n in sorted(par_categorie.items()):
    print(f"    {cat:<24} {n:3d}")

# --- La bibliothèque de versets --------------------------------------------
# Le texte doit se trouver MOT POUR MOT à sa référence : sans ce contrôle, un
# verset mémorisé peut renvoyer à un autre passage quand on va le lire — c'est
# arrivé sur trois psaumes, dont la source comptait la suscription comme
# premier verset.
verses = json.load(io.open('data/verses.json', encoding='utf-8'))['verses']
for v in verses:
    if not segond.contient(v['ref'], v['text']):
        print(f"✗ verset {v['id']} : le texte ne se trouve pas en {v['ref']}"); souci += 1
    if not v.get('contexte'):
        print(f"✗ verset {v['id']} : sans contexte"); souci += 1
print(f"Bibliothèque          {len(verses):3d} versets")

print("\n" + ("✓ tout est cohérent" if souci == 0 else f"✗ {souci} problème(s)"))
sys.exit(1 if souci else 0)
