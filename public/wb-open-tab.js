(function(){
  "use strict";
  function openTab(title,url){
    var protocol=document.currentScript&&document.currentScript.dataset.protocol||"sanlyn:open-tab";
    var path="";
    try{
      var u=new URL(url,location.origin);
      if(u.origin!==location.origin)return;
      path=u.pathname+u.search+u.hash;
    }catch(e){return;}
    if(window.parent!==window)window.parent.postMessage({type:protocol,protocol:protocol,title:title,url:path},location.origin);
    else window.open("/wb-tabs?open="+encodeURIComponent(path)+"&title="+encodeURIComponent(title||path),"_blank","noopener");
  }
  window.SanlynOpenTab=openTab;
  if(typeof window.openWorkbenchTab!=="function")window.openWorkbenchTab=openTab;
})();
