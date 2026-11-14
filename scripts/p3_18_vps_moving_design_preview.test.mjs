import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DESIGN_SCENES,renderMovingDesign} from "./p3_18_vps_moving_design_preview.mjs";

function shell(name,args,encoding="utf8") {
  const r=spawnSync(name,args,{encoding,timeout:35000,maxBuffer:512*1024,
    env:{PATH:process.env.PATH??"/usr/bin:/bin"}});
  assert.equal(r.status,0,name+": "+String(r.stderr).slice(-950));
  return r.stdout;
}
function image(path,color) {
  shell("ffmpeg",[
    "-hide_banner","-loglevel","error","-nostdin","-y",
    "-f","lavfi","-i","color=c="+color+":s=960x540:r=24",
    "-frames:v","1","-q:v","3",path,
  ]);
}
function sha(path) {
  return readFile(path).then(b=>createHash("sha256").update(b).digest("hex"));
}
function pixel(path,time,x,y) {
  const v=shell("ffmpeg",[
    "-hide_banner","-loglevel","error","-nostdin",
    "-ss",String(time),"-i",path,
    "-vf","format=rgb24,crop=1:1:"+x+":"+y+":exact=1",
    "-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1",
  ],null);
  assert.equal(v.length,3);
  return [...v];
}
test("private moving NASA design demo has six scenes and no automatic real-source approval",()=>{
  assert.deepEqual(DESIGN_SCENES.map(x=>x.kind),[
    "atmosphere","atmosphere","atmosphere",
    "dated-ozone-samples","science-map-still","atmosphere",
  ]);
  assert.ok(DESIGN_SCENES.every((x,i)=>x.beat===i+1));
});
test("full 6-second synthetic audiovisual motion proof: source colors replace gradient and dates change",{
  timeout:175000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),"p3-18-moving-demo-ci-"));
  try {
    const file=(name)=>join(root,name+".jpg");
    for(const [id,color] of Object.entries({
      intro:"0x080d42",stat:"0x122a70",metric:"0x1c1459",
      july:"0x00ee40",august:"0x1addea",september:"0x7d4af4",
      october:"0xf02b18",closing:"0x271634",
    })) image(file(id),color);
    const inputs=["intro","stat","metric","july","august",
      "september","october","closing"].map(x=>[file(x),null]);
    for(const pair of inputs) pair[1]=await sha(pair[0]);
    const output=join(root,"six-second-motion-demo.mp4");
    const scenes=[
      {kind:"atmosphere",source:file("intro")},
      {kind:"atmosphere",source:file("stat")},
      {kind:"atmosphere",source:file("metric")},
      {kind:"dated-ozone-samples",sources:[file("july"),file("august"),file("september")]},
      {kind:"science-map-still",source:file("october")},
      {kind:"atmosphere",source:file("closing")},
    ];
    const info=renderMovingDesign({scenes,output,directory:root,secondsPerBeat:1});
    assert.equal(info.streams.length,1);
    assert.equal(info.streams[0].codec_name,"h264");
    assert.equal(info.streams[0].width,1280);
    assert.equal(info.streams[0].height,720);
    assert.equal(Number(info.streams[0].nb_frames),144);
    assert.ok(Math.abs(Number(info.format.duration)-6)<.15);
    // These 3 source images are separate accurate dated samples, never
    // masquerading as the original NASA continuous animation.
    const july=pixel(output,3.15,120,360);
    const august=pixel(output,3.5,120,360);
    const september=pixel(output,3.85,120,360);
    const october=pixel(output,4.5,120,360);
    assert.ok(july[1]>150&&july[1]>july[0]+95,JSON.stringify(july));
    assert.ok(august[2]>90&&august[1]>100,JSON.stringify(august));
    assert.ok(september[2]>130&&september[0]>60,JSON.stringify(september));
    assert.ok(october[0]>170&&october[0]>october[1]+90,JSON.stringify(october));
    for(const [path,original] of inputs)
      assert.equal(await sha(path),original,"Demo must not mutate snapshots");
    // No Piper or actual NASA source movie is needed to run this CI test.
    assert.equal(info.streams.some(x=>x.codec_type==="audio"),false);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
