// doc-css.js — shared CSS for Sanlyn OS document rendering

export var CSS=`<style>
body{font-family:-apple-system,'Helvetica Neue','Helvetica','Arial','PingFang SC',sans-serif;color:#111;margin:0;padding:24px;font-size:11px;line-height:1.4;}
.container{max-width:800px;margin:auto;background:#fff;}
.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1.5px solid #111;padding-bottom:10px;margin-bottom:16px;}
.seller-info{flex:1;min-width:0;}
.seller-name{font-weight:700;color:#111;letter-spacing:0.01em;margin:0 0 4px;text-transform:uppercase;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.seller-info p{font-size:10px;color:#555;margin:0;line-height:1.5;}
.doc-type{text-align:right;flex-shrink:0;margin-left:24px;}
.doc-type h1{margin:0;font-size:22px;font-weight:800;letter-spacing:0.06em;color:#111;line-height:1;}
.doc-type p{font-size:10px;color:#888;letter-spacing:0.18em;margin:4px 0 0;}
.meta-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:28px;margin-bottom:14px;}
.section-label{font-size:9px;font-weight:700;color:#666;letter-spacing:0.12em;text-transform:uppercase;margin:0 0 4px;padding-bottom:4px;border-bottom:1px solid #ddd;}
.meta-grid p[style*="font-size:13px"]{font-size:12px !important;font-weight:700;color:#111;margin:6px 0 3px !important;}
.meta-grid p{font-size:10px;color:#444;line-height:1.5;margin:2px 0;}
.meta-list{list-style:none;padding:0;margin:6px 0 0;}
.meta-list li{margin-bottom:3px;display:flex;justify-content:space-between;font-size:10.5px;}
.meta-list li b{font-weight:normal;color:#777;width:auto;}
.meta-list li{font-family:-apple-system,'Helvetica Neue',sans-serif;}
.meta-list li b+*,.meta-list li :not(b){color:#111;font-family:'SF Mono',Menlo,monospace;text-align:right;}
.trade-terms-bar{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid #e5e5e5;border-radius:2px;margin-bottom:14px;background:#fafafa;padding:0;font-weight:normal;font-size:11px;}
.trade-terms-bar span{padding:8px 12px;border-right:1px solid #e5e5e5;font-weight:600;color:#111;display:block;}
.trade-terms-bar span:last-child{border-right:none;}
table{width:100%;border-collapse:collapse;margin-bottom:14px;margin-top:4px;}
th{background:#f5f5f5;border-top:1.5px solid #111;border-bottom:1px solid #111;padding:7px 8px;font-size:9px;font-weight:700;color:#333;letter-spacing:0.06em;text-transform:uppercase;text-align:left;}
td{padding:8px;font-size:10.5px;border-bottom:1px solid #ececec;vertical-align:top;color:#222;}
.text-right{text-align:right;font-family:'SF Mono',Menlo,monospace;}
.total-row td{border-top:1.5px solid #111;border-bottom:1.5px solid #111;font-weight:800;font-size:11px;background:#fafafa;}
.details-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:12px;page-break-inside:avoid;break-inside:avoid;}
.details-box{border:1px solid #e5e5e5;background:#fafafa;padding:10px 12px;page-break-inside:avoid;break-inside:avoid;font-size:10px;line-height:1.6;color:#333;}
.details-box h4{margin:0 0 6px 0;font-size:9px;font-weight:700;color:#666;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;}
.signature-grid{display:flex;justify-content:space-between;margin-top:36px;page-break-inside:avoid;break-inside:avoid;}
.sig-box{width:46%;border-top:1px solid #111;padding-top:8px;text-align:center;font-size:9px;font-weight:700;color:#444;letter-spacing:0.08em;text-transform:uppercase;display:flex;flex-direction:column;gap:4px;page-break-inside:avoid;break-inside:avoid;}
.sig-box>span:nth-child(2),.sig-box>span:last-child{font-weight:normal;font-size:8.5px;color:#888;text-transform:none;letter-spacing:normal;}
tr,thead,tfoot{page-break-inside:avoid;break-inside:avoid;}
.total-row{page-break-inside:avoid;break-inside:avoid;}
.footer-block{page-break-inside:avoid;break-inside:avoid;display:block;}
.doc-ref{text-align:center;margin-top:18px;padding-top:10px;border-top:1px solid #e5e5e5;font-size:9.5px;color:#666;display:flex;justify-content:center;gap:12px;}
.doc-ref .ref-k{color:#999;}
.doc-ref .ref-v{color:#333;font-family:'SF Mono',Menlo,monospace;font-weight:600;}
.doc-ref .ref-sep{color:#ccc;}
.brand-slogan{text-align:center;margin-top:14px;font-size:8.5px;color:#aaa;letter-spacing:0.1em;}
.brand-slogan b{color:#888;font-weight:600;}
@media print{body{padding:0;}.container{max-width:100%;border:none;}}
</style>`;
