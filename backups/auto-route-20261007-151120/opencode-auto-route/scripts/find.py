#!/usr/bin/env python3
"""Search downloaded skill metadata locally without loading their bodies."""
import argparse,json,re,math
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('query',nargs='?',default='')
p.add_argument('--category')
p.add_argument('--categories',action='store_true')
p.add_argument('--limit',type=int,default=8)
a=p.parse_args()
rows=json.loads((Path(__file__).resolve().parents[1]/'references/catalog.json').read_text())
if a.categories:
 print('\n'.join(sorted({r['category'] for r in rows})));raise SystemExit
stop={'a','an','the','and','or','with','for','to','in','of','my','help','me','use','using'}
terms=[t for t in re.findall(r'[a-z0-9]+',a.query.lower()) if t not in stop]
# Rare exact terms discriminate technologies better than broad substring matches.
def words(text):
 return set(re.findall(r'[a-z0-9]+',text.lower()))
df={t:sum(t in words(r['id']+' '+r['description']+' '+r['category']) for r in rows) for t in terms}
ranked=[]
for r in rows:
 if a.category and r['category']!=a.category:continue
 ident=r['id'];desc=r['description'].lower();category=r['category']
 score=sum(math.log(1+len(rows)/(1+df[t]))*(8*(t in words(ident))+2*(t in words(category))+(t in words(desc))) for t in terms)
 if 'advanced' not in terms and 'advanced' in ident:score*=0.8
 if a.query.lower()==ident:score+=100
 for language in {'rust','python','go','java','javascript','typescript','react','kubernetes','swiftui'} & set(terms):
  if language in words(ident):score+=30
 if score or not terms:ranked.append((score,r))
ranked.sort(key=lambda x:(-x[0],x[1]['id']))
for _,r in ranked[:max(1,a.limit)]:
 print(f"{r['id']} [{r['category']}]\n  {r['description'][:500]}\n  {r['installed']}/SKILL.md")
if not ranked:print('No matching installed skill. Try different terms or use native skills/general capabilities.')
