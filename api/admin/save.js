'use strict';
const handler=require('../_handler.cjs');
module.exports=function(req,res){req.url='/api/admin/save'+(req.url&&req.url.includes('?')?req.url.slice(req.url.indexOf('?')):'');return handler(req,res);};
module.exports.config={api:{bodyParser:{sizeLimit:'4mb'}}};
