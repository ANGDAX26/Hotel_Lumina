const $=id=>document.getElementById(id);
const fmt=x=>(x<0?'-':'')+'$'+Math.abs(Number(x)).toLocaleString('es-MX',{minimumFractionDigits:2});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stars=r=>{r=Math.round(r||0);return '<span class="stars">'+'★'.repeat(r)+'☆'.repeat(5-r)+'</span>'};
const ph=t=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a2118"/><stop offset="1" stop-color="#b8893a"/></linearGradient></defs><rect width="800" height="500" fill="url(#g)"/><text x="400" y="265" font-family="Georgia" font-size="46" fill="#f5efe4" text-anchor="middle">'+String(t).replace(/[<&]/g,'')+'</text></svg>');
const pics=s=>(s||'').split(',').map(x=>x.trim()).filter(Boolean);
const img=(s,t,c='img')=>`<img class="${c}" loading="lazy" src="${esc(pics(s)[0]||ph(t))}" alt="${esc(t)}" data-t="${esc(t)}" onerror="this.onerror=null;this.src=ph(this.dataset.t)">`;
const post=async(u,b)=>{const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return {ok:r.ok,d:await r.json()}};
const cardHTML=`<label>Número de tarjeta<input name="numero" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242"></label><label>Vence (MM/AA)<input name="exp" placeholder="12/28" maxlength="5"></label><label>CVV<input name="cvv" inputmode="numeric" maxlength="4" placeholder="123"></label><p class="note full">Pago simulado de demostración: no se guarda el número de tarjeta. Prueba con 4242 4242 4242 4242 (aprobada) o 4000 0000 0000 0002 (rechazada), cualquier fecha futura y CVV.</p>`;
