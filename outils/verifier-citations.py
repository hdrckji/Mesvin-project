# -*- coding: utf-8 -*-
"""SECONDE lecture, volontairement écrite autrement.

verifier-banques.py compare des CHAÎNES normalisées : il cherche la citation
comme sous-chaîne du verset. C'est efficace, mais une sous-chaîne peut tomber
au milieu d'un mot — « cri » se trouve dans « écrit » — et deux contrôles qui
partagent la même méthode partagent aussi ses angles morts.

Ici, on compare des SUITES DE MOTS : la citation doit former une suite de mots
CONTIGUË du verset. Un mot tronqué ne passe plus. S'ajoutent deux contrôles
que la première lecture ne fait pas du tout :

  - pour « Complète le verset », le mot attendu doit vraiment figurer dans le
    verset (et pas seulement rendre la phrase plausible) ;
  - et les trois autres propositions ne doivent PAS convenir. Sans quoi une
    question aurait deux bonnes réponses, et le joueur qui vérifie aurait
    raison contre l'appli.

Lancement : python3 outils/verifier-citations.py
"""
import json, io, re, sys
sys.path.insert(0, 'outils')
import segond

souci = 0
CITATION = re.compile(r'[«"]\s*(.+?)\s*[»"]', re.S)
TROU = re.compile(r'_{2,}')


def mots(t):
    """Les mots d'un texte, sans casse, sans accents, sans ponctuation.
       L'apostrophe SÉPARE : « d'ouvriers » compte pour « d » et « ouvriers »,
       ce qui rend la comparaison indifférente à « d' ___ » comme à « d'___ »."""
    return [m for m in segond.normalise(t).replace("'", ' ').split() if m]


def suite_contigue(aiguille, meule):
    """Vrai si la liste `aiguille` apparaît telle quelle dans `meule`."""
    n, m = len(aiguille), len(meule)
    if n == 0 or n > m:
        return False
    return any(meule[i:i + n] == aiguille for i in range(m - n + 1))


def citation_tient(ref, extrait):
    """Chaque fragment (séparé par « … ») doit être une suite contiguë du
       verset, et dans l'ordre — on ne recolle pas deux morceaux épars."""
    src = segond.verset(ref)
    if src is None:
        return None                      # référence large : rien à confronter
    meule = mots(src)
    depart = 0
    for frag in (f for f in re.split(r'\s*(?:…|\.\.\.)\s*', extrait or '') if f.strip()):
        aig = mots(frag)
        if not aig:
            continue
        place = None
        for i in range(depart, len(meule) - len(aig) + 1):
            if meule[i:i + len(aig)] == aig:
                place = i
                break
        if place is None:
            return False
        depart = place + len(aig)
    return True


def recolle(question, reponse):
    """La phrase une fois le trou comblé."""
    brut = CITATION.search(question)
    brut = brut.group(1) if brut else question
    return re.sub(r"['’]\s+", "'", TROU.sub(reponse, brut)).rstrip(' .!?;:')


d = json.load(io.open('defi/data/questions.json', encoding='utf-8'))
questions = d['questions']
confrontees = trous = 0

for q in questions:
    ident, ref = q['id'], q.get('reference', '')
    bonne = q['options'][q['bonne']]

    if TROU.search(q['question']):
        trous += 1
        verdict = citation_tient(ref, recolle(q['question'], bonne))
        if verdict is False:
            print(f"✗ {ident} : complétée, la phrase n'est pas une suite de mots de {ref}")
            souci += 1
        elif verdict is True:
            confrontees += 1
            # Le mot attendu doit figurer dans le verset — comparé avec le
            # MÊME tamis que le reste, sinon « colère » ne retrouve pas
            # « colere » et « cœur » ne retrouve pas « coeur ».
            if not suite_contigue(mots(bonne), mots(segond.verset(ref))):
                print(f"✗ {ident} : « {bonne} » ne figure pas dans {ref}")
                souci += 1
            # Et aucune autre proposition ne doit convenir.
            for autre in q['options']:
                if autre == bonne:
                    continue
                if citation_tient(ref, recolle(q['question'], autre)):
                    print(f"✗ {ident} : « {autre} » conviendrait aussi en {ref} — deux bonnes réponses")
                    souci += 1
    else:
        m = CITATION.search(q['question'])
        if m and len(mots(m.group(1))) >= 4:
            verdict = citation_tient(ref, m.group(1).rstrip(' .!?;:'))
            if verdict is False:
                print(f"✗ {ident} : la citation n'est pas une suite de mots de {ref}")
                print(f"      verset   : {segond.verset(ref)}")
                print(f"      question : {m.group(1)}")
                souci += 1
            elif verdict is True:
                confrontees += 1

# Les autres banques passent par le même tamis, avec leurs champs à elles.
for nom, chemin, champ, cle_ref in [
        ("Qui a dit ça ?", 'quiadit/data/banque.json', 'parole', 'reference'),
        ("Écrit… ou pas ?", 'ecritoupas/data/banque.json', 'phrase', 'reference')]:
    for i in json.load(io.open(chemin, encoding='utf-8'))['items']:
        if nom.startswith("Écrit") and not i.get('ecrit'):
            continue                      # « pas écrit » : rien à confronter ici
        verdict = citation_tient(i.get(cle_ref, ''), i[champ])
        if verdict is False:
            print(f"✗ {nom} {i['id']} : « {i[champ][:60]} » n'est pas une suite de mots de {i.get(cle_ref)}")
            souci += 1
        elif verdict is True:
            confrontees += 1

for v in json.load(io.open('data/verses.json', encoding='utf-8'))['verses']:
    verdict = citation_tient(v['ref'], v['text'])
    if verdict is False:
        print(f"✗ verset {v['id']} : le texte n'est pas une suite de mots de {v['ref']}")
        souci += 1
    elif verdict is True:
        confrontees += 1

print(f"\nSeconde lecture : {confrontees} citations confrontées mot à mot "
      f"({trous} « Complète le verset », propositions concurrentes comprises)")
print("✓ chaque citation se lit bien dans le texte de l'appli" if souci == 0
      else f"✗ {souci} problème(s)")
sys.exit(1 if souci else 0)
