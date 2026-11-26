import { getStore } from '@netlify/blobs';
import { randomBytes, randomInt } from 'node:crypto';
import { fresh, view, move } from '../engine.mjs';

const seats = ['mv','pv','ma','pa','view'];
const masters = ['mv','ma'];
const reply = (body, status = 200) => Response.json(body, {status, headers:{'Cache-Control':'private, no-store'}});
const reject = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const teamNames = text => text.replace(/vermelha/gi, m => m[0]==='V'?'Roxa':'roxa').replace(/azul/gi,m=>m[0]==='A'?'Amarela':'amarela');

function snapshot(room, me) {
  let board = null;
  if (room.game) {
    board = view(room.game, me.seat);
    delete board.mapIndex;
    for (const key of ['words','revealed','types']) board[key]=room.order.map(i=>board[key][i]);
    board.log = board.log.map(teamNames);
    board.status = teamNames(board.status);
    board.reason = teamNames(board.reason);
  }
  return {rev:room.rev,owner:me.host,seat:me.seat,board,
    people:room.people.map(p=>({name:p.name,seat:p.seat,you:p===me,host:p.host}))};
}

export async function handle(b, store) {
  const name = typeof b.name==='string' ? b.name.trim() : '';
  const entering = ['create','join'].includes(b.action);
  if (entering && (!name || name.length>32)) reject('Digite um nome com até 32 caracteres.');
  const token = entering ? randomBytes(24).toString('hex') : b.token;
  const player = {token,name,seat:'view',host:b.action==='create'};
  if (b.action==='create') {
    const id=randomBytes(8).toString('hex');
    const room={rev:0,people:[player],game:null,expires:Date.now()+86400000};
    const saved=await store.setJSON(id,room,{onlyIfNew:true});
    if (!saved.modified) reject('Tente criar a sala novamente.',409);
    return {id,token,...snapshot(room,player)};
  }
  if (!/^[0-9a-f]{16}$/.test(b.id||'')) reject('Código de sala inválido.');
  for (let attempt=0;attempt<8;attempt++) {
    const entry=await store.getWithMetadata(b.id,{type:'json'});
    if (!entry || entry.data.expires<Date.now()) reject('Esta sala expirou ou não existe.',404);
    const room=entry.data;
    let me=room.people.find(p=>p.token===token);
    if (b.action==='join') {
      if(room.people.length>=100) reject('Sala cheia.');
      if(room.people.some(p=>p.name.toLocaleLowerCase()===name.toLocaleLowerCase())) reject('Esse nome já está na sala. Use outro.');
      me=player;
      room.people.push(me);
    } else {
      if(!me) reject('Entre novamente na sala.',403);
      if(b.action==='get') return snapshot(room,me);
      if(b.action==='seat') {
        if(room.game) reject('As funções estão fechadas durante a partida.');
        if(!seats.includes(b.seat)) reject('Escolha uma função válida.');
        if(masters.includes(b.seat)&&room.people.some(p=>p!==me&&p.seat===b.seat)) reject('Essa equipe já tem mestre.');
        me.seat=b.seat;
      } else if(b.action==='start') {
        if(!me.host||room.game) reject('Somente o anfitrião pode iniciar a partida no lobby.');
        if(!['mv','ma','pv','pa'].every(s=>room.people.some(p=>p.seat===s))) reject('Cada equipe precisa de um mestre e pelo menos um agente.');
        room.game=fresh();
        room.order=Array.from({length:25},(_,i)=>i);
        for(let i=24;i>0;i--){const j=randomInt(i+1); [room.order[i],room.order[j]]=[room.order[j],room.order[i]];}
      } else if(b.action==='lobby') {
        if(!me.host||!room.game?.winner) reject('Aguarde o fim da partida.');
        room.game=null;
      } else {
        if(!room.game||!['clue','choose','end'].includes(b.action)) reject('Ação indisponível.');
        if(b.rev!==room.rev) reject('O tabuleiro mudou. Confira a jogada atual.',409);
        let payload=b.payload;
        if(b.action==='choose') {
          if(!Number.isInteger(payload?.i)||payload.i<0||payload.i>=25) reject('Carta indisponível.');
          payload={i:room.order[payload.i]};
        }
        try {room.game=move(room.game,me.seat,b.action,payload)} catch(e){reject(e.message)}
      }
    }
    room.rev++;
    const saved=await store.setJSON(b.id,room,{onlyIfMatch:entry.etag});
    if(saved.modified) return {...snapshot(room,me),...(entering?{id:b.id,token}:{})};
  }
  reject('A sala recebeu várias escolhas ao mesmo tempo. Tente novamente.',409);
}
export default async function(req) {
  if(req.method!=='POST') return reply({error:'Método inválido.'},405);
  try {
    const raw=await req.text();
    if(raw.length>4096) reject('Pedido muito grande.');
    let b; try { b=JSON.parse(raw); } catch {reject('Pedido inválido.');}
    if(!b||typeof b!=='object') reject('Pedido inválido.');
    return reply(await handle(b,getStore({name:'imuno-lobby-v3',consistency:'strong'})));
  } catch(e) {return reply({error:e.status?e.message:'Não foi possível conectar à sala. Tente novamente.'},e.status||503);}
}
