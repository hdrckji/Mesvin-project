# -*- coding: utf-8 -*-
"""Contrôle complet des banques d'épreuves contre la Segond embarquée.
À relancer après toute modification de contenu."""
import sys, json, io, collections; sys.path.insert(0, 'outils')
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
