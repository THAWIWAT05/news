const $ = id => document.getElementById(id);
let watchlist = [], market = [], marketErrors = [], chart;
const fmt = n => n == null ? "—" : Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const compact = n => n == null ? "—" : Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:2}).format(n);
const signed = n => n == null ? "—" : `${n >= 0 ? "+" : ""}${fmt(n)}`;
const cls = n => n >= 0 ? "positive" : "negative";
function toast(msg){const el=$("toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2600)}
async function api(url,options){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),18000);
 try{const r=await fetch(url,{...options,signal:controller.signal});let data;
  try{data=await r.json()}catch{throw new Error("เซิร์ฟเวอร์ส่งข้อมูลกลับมาไม่ถูกต้อง")}
  if(!r.ok)throw new Error(data.error||`เกิดข้อผิดพลาด (${r.status})`);return data;
 }catch(e){if(e.name==="AbortError")throw new Error("การเชื่อมต่อใช้เวลานานเกินไป กรุณาลองใหม่");throw e}
 finally{clearTimeout(timer)}
}
async function init(){
  try{const d=await api("/api/watchlist");watchlist=d.symbols;$("assetCount").textContent=String(watchlist.length).padStart(2,"0");populateSelects();await refreshAll();}
  catch(e){toast(e.message)}
}
function populateSelects(){
  for(const id of ["chartSymbol","newsSymbol"]){const el=$(id);el.innerHTML=watchlist.map(s=>`<option value="${s}">${s}</option>`).join("");}
}
async function refreshAll(){
  $("refreshBtn").disabled=true;$("lastUpdate").textContent="กำลังอัปเดต...";
  try{
    const d=await api("/api/market");market=d.results.filter(x=>x.ok).map(x=>x.data);marketErrors=d.results.filter(x=>!x.ok);
    renderCards();renderTable();$("lastUpdate").textContent="อัปเดต "+new Date().toLocaleTimeString("th-TH");
    if(watchlist.length){await loadChart($("chartSymbol").value||watchlist[0]);}
  }catch(e){toast(e.message)}
  $("refreshBtn").disabled=false;
}
function renderCards(){
  $("marketCards").innerHTML=market.map(x=>`<article class="panel asset-card" data-symbol="${x.symbol}"><div class="asset-top"><span class="asset-name">${escapeHtml(x.name)}</span><span>${escapeHtml(x.symbol)}</span></div><div class="price">${fmt(x.price)}</div><div class="change ${cls(x.change)}">${signed(x.change)} (${signed(x.changePercent)}%)</div><div class="premarket-line">ก่อนเปิดตลาด: <b class="${x.preMarketChangePercent==null?'':cls(x.preMarketChangePercent)}">${x.preMarketPrice==null?'ไม่มีข้อมูลจากผู้ให้บริการ':`$${fmt(x.preMarketPrice)} (${signed(x.preMarketChangePercent)}%)`}</b></div><div class="premarket-line">หลังปิดตลาด: <b class="${x.postMarketChangePercent==null?'':cls(x.postMarketChangePercent)}">${x.postMarketPrice==null?'—':`$${fmt(x.postMarketPrice)} (${signed(x.postMarketChangePercent)}%)`}</b></div><div class="news-meta">สถานะตลาด: ${escapeHtml(x.marketState||"ไม่ทราบ")}</div></article>`).join("")||'<div class="loading">ไม่สามารถโหลดข้อมูลได้ ลองรีเฟรชอีกครั้ง</div>';
  if(marketErrors.length){const warning=document.createElement("div");warning.className="market-warning";warning.textContent="หุ้นบางรายการโหลดไม่สำเร็จ: "+marketErrors.map(x=>x.symbol).join(", ")+" — ผู้ให้บริการอาจจำกัดคำขอหรือไม่มีข้อมูลชั่วคราว";$("marketCards").appendChild(warning)}
  document.querySelectorAll(".asset-card").forEach(el=>el.addEventListener("click",()=>selectSymbol(el.dataset.symbol)));
}
function statusFor(rsi,price,ema){if(rsi==null)return ["ข้อมูลไม่เพียงพอ",""];if(rsi<30)return ["แรงขายมาก","warn"];if(rsi>70)return ["แรงซื้อมาก","warn"];if(ema!=null&&price>ema)return ["ราคาเหนือ EMA20","good"];return ["เป็นกลาง",""];}
function renderTable(){
  $("watchRows").innerHTML=market.map(x=>{const [label,tag]=statusFor(x.indicators.rsi14,x.price,x.indicators.ema20);return `<tr data-symbol="${x.symbol}"><td class="symbol">${x.symbol}</td><td>$${fmt(x.price)}</td><td class="${cls(x.change)}">${signed(x.changePercent)}%</td><td>${fmt(x.indicators.rsi14)}</td><td>${fmt(x.indicators.ema20)}</td><td>${compact(x.volume)}</td><td><span class="pill ${tag}">${label}</span></td></tr>`}).join("")||'<tr><td colspan="7">ไม่มีข้อมูล</td></tr>';
  if(marketErrors.length){$("watchRows").insertAdjacentHTML("beforeend",marketErrors.map(x=>`<tr><td class="symbol">${escapeHtml(x.symbol)}</td><td colspan="6" class="negative">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(x.error)}</td></tr>`).join(""))}
  document.querySelectorAll("#watchRows tr[data-symbol]").forEach(el=>el.addEventListener("click",()=>selectSymbol(el.dataset.symbol)));
}
function selectSymbol(symbol){$("chartSymbol").value=symbol;$("newsSymbol").value=symbol;loadChart(symbol)}
async function loadChart(symbol){
  try{
    const x=market.find(q=>q.symbol===symbol)||await api("/api/quote/"+encodeURIComponent(symbol));
    $("chartTitle").textContent=`${symbol} · ${x.history.length} วันล่าสุด`;
    const ctx=$("priceChart").getContext("2d");if(chart)chart.destroy();
    chart=new Chart(ctx,{type:"line",data:{labels:x.history.map(p=>p.date),datasets:[{data:x.history.map(p=>p.close),borderColor:"#53e0d0",backgroundColor:"rgba(83,224,208,.08)",fill:true,tension:.25,pointRadius:0,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{mode:"index",intersect:false}},scales:{x:{ticks:{color:"#71869b",maxTicksLimit:7},grid:{color:"#1b2937"}},y:{ticks:{color:"#71869b"},grid:{color:"#1b2937"}}}}});
    renderSignals(x);loadNews(symbol);
  }catch(e){$("signals").innerHTML=`<div class="loading">${e.message}</div>`}
}
function renderSignals(x){
 const i=x.indicators;const rows=[["RSI (14)",fmt(i.rsi14),i.rsi14<30?"แรงขายมาก":i.rsi14>70?"แรงซื้อมาก":"เป็นกลาง"],["EMA 20",fmt(i.ema20),x.price>i.ema20?"ราคาอยู่เหนือเส้น":"ราคาอยู่ใต้เส้น"],["EMA 50",fmt(i.ema50),x.price>i.ema50?"ราคาอยู่เหนือเส้น":"ราคาอยู่ใต้เส้น"],["SMA 200",fmt(i.sma200),"ค่าเฉลี่ยระยะยาว"],["MACD",fmt(i.macd),i.histogram>0?"โมเมนตัมเป็นบวก":"โมเมนตัมเป็นลบ"],["แนวรับ 20 วัน",fmt(i.support),"ต่ำสุด 20 วัน"],["แนวต้าน 20 วัน",fmt(i.resistance),"สูงสุด 20 วัน"]];
 $("signals").innerHTML=rows.map(r=>`<div class="signal-row"><span>${r[0]}</span><strong>${r[1]} <small style="color:#8291a5">${r[2]}</small></strong></div>`).join("");
}
async function loadNews(symbol){
 $("newsList").innerHTML='<div class="loading">กำลังรวบรวมข่าว...</div>';
 try{
  const d=await api("/api/news?symbol="+encodeURIComponent(symbol));
  const toneLabel={positive:"ข่าวเชิงบวก",negative:"ข่าวเชิงลบ",neutral:"ยังไม่ชัดเจน"};
  $("newsList").innerHTML=d.items.map(n=>`<article class="news-item">
   <div class="news-badges"><span class="news-symbol">${escapeHtml(symbol)}</span><span class="news-tone ${escapeHtml(n.tone)}">${toneLabel[n.tone]||"ข่าวทั่วไป"}</span></div>
   <a href="${escapeHtml(n.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.title)}</a>
   <p class="news-summary">${escapeHtml(n.summary||"เปิดอ่านเนื้อหาต้นฉบับเพื่อดูรายละเอียด")}</p>
   <div class="news-impact">ผลกระทบ: <b>${escapeHtml(n.impact||"ยังไม่ชัด")}</b> · ระดับ: <b>${escapeHtml(n.impactLevel||"ประเมินไม่ได้")}</b><br>ทิศทางจากพาดหัว: <b>${escapeHtml(n.direction||"ยังไม่ชัดเจน")}</b></div>
   <div class="news-meta">${escapeHtml(n.source||"Google News")} · ${n.pubDate?new Date(n.pubDate).toLocaleString("th-TH"):"ไม่ระบุเวลา"} · <a href="${escapeHtml(n.link)}" target="_blank" rel="noopener noreferrer">อ่านข่าวต้นฉบับ ↗</a></div>
  </article>`).join("")||'<div class="loading">ไม่พบข่าวสำหรับหุ้นนี้ในขณะนี้</div>';
  if(d.note){const note=document.querySelector(".news-note");if(note)note.textContent=d.note}
 }catch(e){$("newsList").innerHTML=`<div class="loading">${escapeHtml(e.message)}<br><br>ลองกดรีเฟรชอีกครั้ง หรือเปลี่ยนหุ้นที่เลือก</div>`}
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
$("refreshBtn").addEventListener("click",refreshAll);
$("chartSymbol").addEventListener("change",e=>selectSymbol(e.target.value));
$("newsSymbol").addEventListener("change",e=>loadNews(e.target.value));
$("editWatchlist").addEventListener("click",()=>{$("symbolsInput").value=watchlist.join(",");$("modal").classList.add("show")});
$("closeModal").addEventListener("click",()=>$("modal").classList.remove("show"));
$("modal").addEventListener("click",e=>{if(e.target===$("modal"))$("modal").classList.remove("show")});
$("saveWatchlist").addEventListener("click",async()=>{
 try{const symbols=$("symbolsInput").value.split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);const d=await api("/api/watchlist",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbols})});watchlist=d.symbols;$("modal").classList.remove("show");$("assetCount").textContent=String(watchlist.length).padStart(2,"0");populateSelects();await refreshAll();toast("บันทึกรายการติดตามเรียบร้อยแล้ว")}
 catch(e){$("modalStatus").textContent=e.message}
});
$("telegramTest").addEventListener("click",async()=>{const s=$("telegramStatus");s.textContent="กำลังทดสอบการเชื่อมต่อ...";try{const d=await api("/api/telegram/test",{method:"POST"});s.textContent=d.message;toast(d.message)}catch(e){s.textContent=e.message}});
const reportButton=$("telegramReport");
if(reportButton)reportButton.addEventListener("click",async()=>{const s=$("telegramStatus");reportButton.disabled=true;s.textContent="กำลังรวบรวมราคาและข่าวหุ้นทั้งหมด...";try{const d=await api("/api/telegram/report",{method:"POST"});s.textContent=d.message;toast(d.message)}catch(e){s.textContent=e.message}finally{reportButton.disabled=false}});
init();
