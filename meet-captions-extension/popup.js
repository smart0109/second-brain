const $=(id)=>document.getElementById(id);
chrome.storage.local.get(['appUrl','code'],(d)=>{
  $('appUrl').value=d.appUrl||'https://second-brain-iida.onrender.com';
  $('code').value=d.code||'';
});
$('save').onclick=()=>{
  const appUrl=($('appUrl').value||'').trim().replace(/\/+$/,'');
  const code=($('code').value||'').trim().toUpperCase();
  chrome.storage.local.set({appUrl,code},()=>{
    $('status').textContent='Saved. Open/refresh your Meet tab.';
    $('status').style.color='#16a34a';
  });
};
