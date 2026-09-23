// Exact sampling without replacement; source access, not spell castability.
export function sourceOdds({deck=40,sources,needed=1,turn=3,onDraw=false}) {
  for (const [label,value,min,max] of [['deck',deck,7,100],['sources',sources,0,deck],['needed',needed,1,10],['turn',turn,1,20]]) {
    if (!Number.isInteger(value) || value<min || value>max) throw new RangeError(`Invalid ${label}`);
  }
  if (typeof onDraw !== 'boolean') throw new TypeError('onDraw must be boolean');
  const seen=Math.min(deck,7+turn-(onDraw?0:1));
  // Dynamic hypergeometric distribution. Index is sources drawn so far.
  let distribution=[1];
  for(let drawn=0;drawn<seen;drawn++) {
    const next=Array(drawn+2).fill(0);
    for(let hit=0;hit<distribution.length;hit++) {
      if (!distribution[hit]) continue;
      const remainingSources=sources-hit, remainingOther=deck-sources-(drawn-hit);
      if(remainingOther>0) next[hit]+=distribution[hit]*remainingOther/(deck-drawn);
      if(remainingSources>0) next[hit+1]+=distribution[hit]*remainingSources/(deck-drawn);
    }
    distribution=next;
  }
  return {seen,probability:Math.min(1,Math.max(0,distribution.reduce((sum,p,k)=>sum+(k>=needed?p:0),0)))};
}
