(function(){
  "use strict";
  function openTab(title,url){
    if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",title:title,url:url},location.origin);
    else window.open(url,"_blank");
  }
  // 2026-08-30 嵌入外壳(/hy/)时隐藏页面自带侧边栏——原因:10个页面自带 <aside class=side>
  // 跟外壳侧边栏打架,导致它们被 REMOVED_SHELL_PAGES 踢出去、模块显示还没接通。
  try{ if(window.parent!==window) document.documentElement.classList.add("sanlyn-embedded"); }catch(e){
    // 跨域取不到 parent 也说明在 iframe 里
    document.documentElement.classList.add("sanlyn-embedded");
  }
  window.SanlynOpenTab=openTab;
  if(typeof window.openWorkbenchTab!=="function")window.openWorkbenchTab=openTab;
})();
