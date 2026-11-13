import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  buildEpisodeAssetResearchPlan, createEpisodeMediaLibrary,
} from "./p3_episode_asset_library.mjs";
import {
  rankEpisodeMediaCandidates, scoreMediaCandidate,
} from "./p3_media_candidate_ranking.mjs";
import {
  buildOfflineMediaBoard, renderOfflineMediaBoardHtml,
  runOfflineMediaBoardCli, validatePrivateThumbnailSource,
} from "./p3_media_review_board.mjs";

function fixtureLibrary() {
  const sections = ["hook", "basics", "measurement", "vortex",
    "impact", "next", "takeaways"].map((id, i) => ({
    id, visuals: Array.from({length:[2,3,3,3,3,3,2][i]},(_,j) => ({
      title: i === 0 && j === 0 ?
        "City night landscape" : "Antarctic ozone " + id + " " + j,
    })),
  }));
  const plan = buildEpisodeAssetResearchPlan({
    schemaVersion:1,id:"ozone-2026-explained-en",
    asOf:"2026-11-13", sections,
  });
  const basic = {
    creator:"CI Contributor",credit:"CI / sample metadata",
    licensePage:"https://www.nasa.gov/nasa-brand-center/images-and-media/",
    mediaType:"video",
  };
  return createEpisodeMediaLibrary(plan, [{
    ...basic,sceneId:"beat-02",provider:"nasa",providerId:"OZONE-SCIENCE",
    title:"Antarctic ozone scientific animation",
    description:"Antarctic ozone observations and measured change",
    sourcePage:"https://images.nasa.gov/details/OZONE-SCIENCE",
    durationSeconds:18,width:1920,height:1080,
  }, {
    ...basic,sceneId:"beat-02",provider:"nasa",providerId:"OZONE-LOW",
    title:"Polar atmosphere overview",
    sourcePage:"https://images.nasa.gov/details/OZONE-LOW",
    durationSeconds:1,width:320,height:180,
  }, {
    ...basic,sceneId:"beat-02",provider:"pexels",providerId:"12345",
    title:"Nice polar mountains",
    description:"Landscape without ozone scientific measurements",
    sourcePage:"https://www.pexels.com/video/synthetic-12345/",
    licensePage:"https://www.pexels.com/license/",
    durationSeconds:10,width:1280,height:720,
  }, {
    ...basic,sceneId:"beat-01",provider:"pexels",providerId:"900",
    title:'<img src=x onerror="alert(1)"> Night sky',
    sourcePage:"https://www.pexels.com/video/synthetic-900/",
    licensePage:"https://www.pexels.com/license/",
    durationSeconds:15,width:1280,height:720,
  }]);
}
function call(name,args) {
  const result=spawnSync(name,args,{
    encoding:"utf8",timeout:60000,
    env:{PATH:process.env.PATH ?? "/usr/bin:/bin"},
  });
  assert.equal(result.status,0,name+" "+(result.stderr??"").slice(-900));
}
test("science and B-roll are ranked separately; metadata score never implies rights approval",()=>{
  const library=fixtureLibrary();
  const ranked=rankEpisodeMediaCandidates(library);
  assert.equal(ranked.scenes.length,19);
  assert.equal(ranked.sourceCandidates,4);
  assert.equal(ranked.publicationAllowed,false);
  assert.equal(ranked.rightsApproved,false);
  assert.match(ranked.scoreMeaning,/NOT_AI_VISUAL_VERIFICATION/);
  const science=ranked.scenes[1];
  assert.equal(science.sceneId,"beat-02");
  assert.equal(science.science.length,2);
  assert.equal(science.broll.length,1);
  assert.equal(science.science[0].id,"nasa:OZONE-SCIENCE");
  assert.ok(science.science[0].score > science.science[1].score);
  assert.match(science.broll[0].role,/CONTEXT_ONLY_NOT_EVIDENCE/);
  assert.equal(science.broll[0].rightsApproved,false);
  assert.ok(ranked.scenes.some(s=>s.status==="MISSING_SCIENCE_SOURCE_CANDIDATES"));
  assert.equal(ranked.scenes[0].metadataTopCandidate,"pexels:900");
  const copy=structuredClone(library);
  copy.candidates[0].rightsApproved=true;
  assert.throws(()=>rankEpisodeMediaCandidates(copy),/unapproved status/);
  const dup=structuredClone(library);
  dup.candidates.push({...dup.candidates[0],sceneId:"beat-03"});
  assert.throws(()=>rankEpisodeMediaCandidates(dup),/Repeated motif/);
  const wrong=structuredClone(library);
  wrong.candidates[0].id="nasa:other";
  assert.throws(()=>rankEpisodeMediaCandidates(wrong),/provenance/);
  assert.throws(()=>scoreMediaCandidate({
    sceneId:"beat-01",label:"One",searchQuery:"One",
    scienceSourceRequired:false,
  },library.candidates[0]),/assert/);
});
test("offline board escapes untrusted metadata and exports a locked draft only",()=>{
  const ranked=rankEpisodeMediaCandidates(fixtureLibrary());
  const html=renderOfflineMediaBoardHtml(ranked);
  assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html,/<img src=x onerror/);
  assert.match(html,/Content-Security-Policy/);
  assert.match(html,/connect-src &#39;none&#39;/);
  assert.match(html,/img-src data:/);
  assert.match(html,/approvePreviewAcquisition:false/);
  assert.match(html,/allowPublication:false/);
  assert.match(html,/REQUIRES_OFFICIAL_DIRECT_FILE_URL_REVIEW/);
  assert.doesNotMatch(html,/<img[^>]+src="https:/);
  assert.match(html,/target="_blank" rel="noopener noreferrer"/);
  assert.match(html,/nasa:OZONE-SCIENCE/);
  assert.match(html,/Stock – nur atmosphärischer Kontext/);
  assert.match(html,/Metadaten \d+\/100/);
});
test("only local hash-pinned quarantine bytes produce an embedded thumbnail; no remote access",async()=>{
  const root=await mkdtemp(join(tmpdir(),"p3-private-review-"));
  try {
    const workspace=join(root,"episode-private");
    const quarantine=join(workspace,"quarantine");
    await mkdir(workspace,{mode:0o700});
    await mkdir(quarantine,{mode:0o700});
    const raw=join(root,"fixture.mp4");
    call("ffmpeg",[
      "-hide_banner","-loglevel","error","-nostdin","-y",
      "-f","lavfi","-i","testsrc2=size=640x360:rate=24",
      "-t","1","-c:v","libx264","-threads:v","1",
      "-pix_fmt","yuv420p","-an",raw,
    ]);
    const bytes=await readFile(raw);
    const sha256=createHash("sha256").update(bytes).digest("hex");
    const localPath=join(quarantine,sha256+".mp4");
    await writeFile(localPath,bytes,{mode:0o600});
    const library=fixtureLibrary();
    const record={
      candidateId:"nasa:OZONE-SCIENCE",sceneId:"beat-02",
      motifId:"nasa:OZONE-SCIENCE",sha256,localPath,
      status:"QUARANTINED_REVIEW_REQUIRED",
      rightsApproved:false,editorialApproved:false,
      thirdPartyRightsCleared:false,
    };
    const receipt={
      schemaVersion:1,episodeId:library.episodeId,
      status:"QUARANTINE_ONLY_REQUIRES_REVIEW",
      records:[record],
    };
    const board=await buildOfflineMediaBoard({
      libraryDocument:{library},workspace,receipt,
    });
    assert.equal(board.localPreviews,1);
    assert.match(board.html,/data:image\/jpeg;base64,/);
    assert.doesNotMatch(board.html,/<img[^>]+src="https:/);
    assert.equal(board.publicationAllowed,false);
    const source=await validatePrivateThumbnailSource(
      record,quarantine,new Set([record.candidateId]));
    assert.equal(source,localPath);
    await assert.rejects(()=>buildOfflineMediaBoard({
      libraryDocument:{library},workspace,
      receipt:{...receipt,records:[{...record,sha256:"0".repeat(64)}]},
    }),/Hash-named|assert/);
    const wrong=join(quarantine,sha256+"-extra.mp4");
    await writeFile(wrong,bytes);
    await assert.rejects(()=>validatePrivateThumbnailSource({
      ...record,localPath:wrong,
    },quarantine,new Set([record.candidateId])),/assert/);
    const linked=join(quarantine,"link.mp4");
    await symlink(raw,linked);
    await assert.rejects(()=>validatePrivateThumbnailSource({
      ...record,localPath:linked,
    },quarantine,new Set([record.candidateId])),/assert/);

    const libraryPath=join(workspace,"episode-library.json");
    await writeFile(libraryPath,JSON.stringify(library),{mode:0o600});
    const receiptPath=join(workspace,"quarantine-receipt.json");
    await writeFile(receiptPath,JSON.stringify(receipt),{mode:0o600});
    const summary=await runOfflineMediaBoardCli([
      libraryPath,workspace,"--receipt="+receiptPath,
    ]);
    assert.equal(summary.localPreviews,1);
    assert.equal(summary.publicationAllowed,false);
    assert.equal((await stat(summary.output)).mode & 0o077,0);
    assert.match(await readFile(summary.output,"utf8"),/jpeg;base64/);
    await assert.rejects(()=>runOfflineMediaBoardCli([libraryPath,workspace]),
      /EEXIST/);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
