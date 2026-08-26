(function(){
  "use strict";
  function openTab(title,url){
    if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",title:title,url:url},location.origin);
    else window.open(url,"_blank");
  }
  window.SanlynOpenTab=openTab;
  if(typeof window.openWorkbenchTab!=="function")window.openWorkbenchTab=openTab;
})();
