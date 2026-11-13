/* ========= CONFIG =========
   Deploy Code.gs as a Web App, then paste the /exec URL below.
   JSONP is used so GitHub Pages can communicate with Apps Script without CORS issues.
================================ */
const API_URL = "PASTE_YOUR_APPS_SCRIPT_WEB_APP_EXEC_URL_HERE";
const GAME_SECONDS = 60;
const CALIBRATION_FRAMES = 45;

const $ = id => document.getElementById(id);
const homeScreen=$("homeScreen"), gameScreen=$("gameScreen"), resultScreen=$("resultScreen");
const video=$("webcam"), canvas=$("overlay"), ctx=canvas.getContext("2d");
let stream=null, running=false, score=0, combo=0, timeLeft=GAME_SECONDS;
let poseLandmarker=null, lastVideoTime=-1, animationId=null, timerId=null;
let calibrationCount=0, readyToScore=false, lastScoreAt=0, ball=null;

$("startBtn").addEventListener("click", startGame);
$("exitBtn").addEventListener("click", () => finishGame(false));
$("playAgainBtn").addEventListener("click", () => {resultScreen.classList.add("hidden");homeScreen.classList.remove("hidden")});
$("leaderboardBtn").addEventListener("click", showLeaderboard);
$("resultLeaderboardBtn").addEventListener("click", showLeaderboard);
$("closeLeaderboard").addEventListener("click", ()=>$("leaderboardModal").classList.add("hidden"));
$("closeError").addEventListener("click", ()=>{$("errorModal").classList.add("hidden")});

function setStatus(title,text){$("statusTitle").textContent=title;$("statusText").textContent=text}
function showError(title,text){$("errorTitle").textContent=title;$("errorText").textContent=text;$("errorModal").classList.remove("hidden")}

async function startGame(){
  const name=$("playerName").value.trim();
  if(!name){showError("ใส่ชื่อก่อนเริ่มเกม 😊","กรุณาพิมพ์ชื่อผู้เล่น แล้วกดเริ่มอีกครั้ง");return}
  homeScreen.classList.add("hidden"); gameScreen.classList.remove("hidden");
  score=0;combo=0;timeLeft=GAME_SECONDS;calibrationCount=0;readyToScore=false;ball=null;
  updateUI(); setStatus("กำลังเปิดกล้อง...","Safari จะขอสิทธิ์ใช้งานกล้อง");

  try{
    if(!window.isSecureContext) throw new Error("หน้านี้ไม่ใช่ Secure Context (HTTPS)");
    if(!navigator.mediaDevices?.getUserMedia) throw new Error("เบราว์เซอร์ไม่รองรับ Camera API");

    stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:"user"},width:{ideal:1280},height:{ideal:720}},
      audio:false
    });
    video.srcObject=stream;
    await video.play();

    canvas.width=video.videoWidth||720; canvas.height=video.videoHeight||1280;
    setStatus("กำลังโหลด AI...","เตรียมระบบตรวจจับท่าอันเดอร์");
    await loadPoseModel();

    running=true;
    setStatus("ตั้งท่าอันเดอร์ 🤝","ประสานมือ เหยียดแขน ค้างไว้สักครู่");
    startTimer();
    predictLoop();
  }catch(err){
    console.error(err);
    stopCamera();
    gameScreen.classList.add("hidden");homeScreen.classList.remove("hidden");
    const msg = err.name==="NotAllowedError"
      ? "Safari ไม่อนุญาตให้ใช้กล้อง หรือเว็บไซต์ถูกบล็อกสิทธิ์กล้อง กรุณาเปิดการอนุญาต Camera สำหรับเว็บไซต์นี้ แล้วลองใหม่"
      : err.message;
    showError("เปิดกล้องหรือโหลด AI ไม่สำเร็จ",msg);
  }
}

async function loadPoseModel(){
  if(poseLandmarker) return;
  const {FilesetResolver, PoseLandmarker}=window.vision;
  const vision=await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm");
  poseLandmarker=await PoseLandmarker.createFromOptions(vision,{
    baseOptions:{modelAssetPath:"https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"},
    runningMode:"VIDEO",numPoses:1
  });
}

function predictLoop(){
  if(!running)return;
  if(video.readyState>=2 && video.currentTime!==lastVideoTime){
    lastVideoTime=video.currentTime;
    const result=poseLandmarker.detectForVideo(video,performance.now());
    drawFrame(result);
  }
  animationId=requestAnimationFrame(predictLoop);
}

function drawFrame(result){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const pose=result.landmarks?.[0];
  if(pose){
    drawSkeleton(pose);
    const under=checkUnderPass(pose);
    if(!readyToScore){
      calibrationCount=under.good ? calibrationCount+1 : Math.max(0,calibrationCount-2);
      const pct=Math.min(100,Math.round(calibrationCount/CALIBRATION_FRAMES*100));
      setStatus("ตั้งท่าอันเดอร์ 🤝",`กำลังปรับเทียบ ${pct}%`);
      if(calibrationCount>=CALIBRATION_FRAMES){
        readyToScore=true;
        setStatus("พร้อมแล้ว! 🏐","รักษาท่าอันเดอร์และรับลูกบอล!");
        spawnBall();
      }
    }else{
      updateBall(under);
    }
  }else if(readyToScore){
    $("tipBubble").textContent="👀 ขยับให้เห็นช่วงบนและแขนทั้งสองข้าง";
  }
}

function checkUnderPass(p){
  // MediaPipe: 11/12 shoulders, 13/14 elbows, 15/16 wrists.
  const Ls=p[11],Rs=p[12],Le=p[13],Re=p[14],Lw=p[15],Rw=p[16];
  if(!Lw||!Rw||!Le||!Re)return {good:false};
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const wristDistance=dist(Lw,Rw);
  const leftArm=dist(Ls,Le)+dist(Le,Lw);
  const leftStraight=dist(Ls,Lw)/Math.max(leftArm,.001);
  const rightArm=dist(Rs,Re)+dist(Re,Rw);
  const rightStraight=dist(Rs,Rw)/Math.max(rightArm,.001);
  const armsStraight=leftStraight>.82 && rightStraight>.82;
  const handsTogether=wristDistance<.18;
  const wristsForward=(Lw.y+Rw.y)/2 > (Ls.y+Rs.y)/2-.05;
  return {good:armsStraight&&handsTogether&&wristsForward,
          x:(Lw.x+Rw.x)/2,y:(Lw.y+Rw.y)/2,wristDistance};
}

function drawSkeleton(p){
  const pairs=[[11,13],[13,15],[12,14],[14,16],[11,12]];
  ctx.lineWidth=7;ctx.strokeStyle="rgba(109,189,255,.9)";
  for(const [a,b] of pairs){ctx.beginPath();ctx.moveTo(p[a].x*canvas.width,p[a].y*canvas.height);ctx.lineTo(p[b].x*canvas.width,p[b].y*canvas.height);ctx.stroke()}
  for(const i of [11,12,13,14,15,16]){ctx.beginPath();ctx.fillStyle="#ffd64d";ctx.arc(p[i].x*canvas.width,p[i].y*canvas.height,7,0,Math.PI*2);ctx.fill()}
}

function spawnBall(){
  ball={x:.2+Math.random()*.6,y:-.08,vy:.0028+score*.00003,r:.055,active:true};
}

function updateBall(under){
  if(!ball?.active)return;
  ball.y+=ball.vy;
  const x=ball.x*canvas.width,y=ball.y*canvas.height,r=ball.r*canvas.width;
  ctx.font=`${r*2}px serif`;ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText("🏐",x,y);

  if(under.good){
    const dx=ball.x-under.x,dy=ball.y-under.y;
    if(Math.hypot(dx,dy)<ball.r+.075 && performance.now()-lastScoreAt>800){
      lastScoreAt=performance.now();score++;combo++;
      $("score").textContent=score;$("combo").textContent="x"+combo;
      $("tipBubble").textContent="✨ PERFECT UNDER PASS! +1";
      ball=null;setTimeout(spawnBall,650);return;
    }
  }
  if(ball.y>1.15){combo=0;$("combo").textContent="x0";$("tipBubble").textContent="🤝 จัดมือให้ชิดและเหยียดแขนให้ตรง";spawnBall()}
}

function startTimer(){
  clearInterval(timerId);
  timerId=setInterval(()=>{
    timeLeft--; $("timer").textContent=timeLeft;
    if(timeLeft<=0)finishGame(true);
  },1000);
}
function updateUI(){$("score").textContent=score;$("combo").textContent="x0";$("timer").textContent=timeLeft}
function stopCamera(){cancelAnimationFrame(animationId);clearInterval(timerId);running=false;if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}video.srcObject=null}

async function finishGame(save){
  stopCamera();gameScreen.classList.add("hidden");
  if(!save){homeScreen.classList.remove("hidden");return}
  $("finalScore").textContent=score;$("resultName").textContent=$("playerName").value.trim();$("saveStatus").textContent="กำลังบันทึกคะแนน...";
  resultScreen.classList.remove("hidden");
  try{await apiJSONP({action:"save",name:$("playerName").value.trim(),score});$("saveStatus").textContent="✅ บันทึกคะแนนแล้ว!"}
  catch(e){console.warn(e);$("saveStatus").textContent="⚠️ เล่นจบแล้ว แต่ยังบันทึกคะแนนไม่ได้"}
}

function apiJSONP(params){
  return new Promise((resolve,reject)=>{
    if(!API_URL.startsWith("http")) return reject(new Error("ยังไม่ได้ตั้งค่า API_URL"));
    const cb="jsonp_"+Date.now()+"_"+Math.floor(Math.random()*9999);
    const qs=new URLSearchParams({...params,callback:cb});
    const script=document.createElement("script");
    const timer=setTimeout(()=>cleanup(new Error("API timeout")),10000);
    window[cb]=data=>cleanup(null,data);
    script.onerror=()=>cleanup(new Error("โหลด API ไม่สำเร็จ"));
    function cleanup(err,data){clearTimeout(timer);delete window[cb];script.remove();err?reject(err):resolve(data)}
    script.src=API_URL+"?"+qs.toString();document.body.appendChild(script);
  });
}

async function showLeaderboard(){
  $("leaderboardModal").classList.remove("hidden");
  const list=$("leaderboardList");list.innerHTML="<li>กำลังโหลด...</li>";
  try{
    const data=await apiJSONP({action:"leaderboard"});
    const rows=data.rows||[];
    list.innerHTML=rows.length?rows.map(r=>`<li>${escapeHTML(r.name)} <span>${Number(r.score)||0}</span></li>`).join(""):"<li>ยังไม่มีคะแนน</li>";
  }catch(e){list.innerHTML="<li>ยังโหลดอันดับไม่ได้ กรุณาตั้งค่า API_URL</li>"}
}
function escapeHTML(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}