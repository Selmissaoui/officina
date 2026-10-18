'use strict';
// Deterministic candle backtests only. No exchange orders are submitted here.
function backtest({ prices, strategy='dca', initial=10000, allocation=100, every=5, gridPct=2, feePct=0.1 }) {
  if (!Array.isArray(prices) || prices.length<2 || prices.length>10000 || prices.some(p=>!Number.isFinite(Number(p))||Number(p)<=0)) throw new Error('Provide between 2 and 10,000 positive closing prices');
  for(const [k,v] of Object.entries({initial,allocation,every,gridPct,feePct}))if(!Number.isFinite(Number(v))||Number(v)<0)throw new Error('Invalid '+k);
  if(initial<=0||allocation<=0||every<1||gridPct<=0||feePct>=100)throw new Error('Invalid strategy settings');
  if(!['dca','grid'].includes(strategy))throw new Error('Choose DCA or grid');
  let cash=Number(initial),qty=0,anchor=Number(prices[0]),peak=cash,maxDrawdown=0;const trades=[],equity=[];
  const fee=Number(feePct)/100;
  for(let i=0;i<prices.length;i++){
    const price=Number(prices[i]);
    const buy=strategy==='dca'?i%Math.floor(every)===0:price<=anchor*(1-gridPct/100);
    const sell=strategy==='grid'&&price>=anchor*(1+gridPct/100)&&qty>0;
    if(buy&&cash>0){const cost=Math.min(Number(allocation),cash/(1+fee)),amount=cost/price;cash-=cost*(1+fee);qty+=amount;trades.push({index:i,side:'buy',price,amount});anchor=price;}
    else if(sell){const amount=Math.min(qty,Number(allocation)/price);cash+=amount*price*(1-fee);qty-=amount;trades.push({index:i,side:'sell',price,amount});anchor=price;}
    const value=cash+qty*price;peak=Math.max(peak,value);maxDrawdown=Math.max(maxDrawdown,(peak-value)/peak);equity.push(value);
  }
  return {cash,qty,finalEquity:equity.at(-1),profit:equity.at(-1)-initial,returnPct:(equity.at(-1)/initial-1)*100,maxDrawdownPct:maxDrawdown*100,trades,equity};
}
module.exports={backtest};
