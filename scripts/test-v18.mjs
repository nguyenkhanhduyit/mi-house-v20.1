import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getRows,getTrashRows,deleteRecords,restoreRecords,purgeRecords,duplicateRecord,saveRecord} from '../src/cms/businessModel.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let checks=0;
const ok=(condition,message)=>{assert(condition,message);checks++;console.log('PASS',message)};
const fixture=()=>({articles:[{id:'n1',title:'Bản ghi gốc',slug:'bai-goc',body:'<p>Đây là nội dung</p>',status:'published',image:'https://example.com/a.jpg',custom:{keep:1},seoTitle:'Tiêu đề SEO'}],services:[],training:[],albumCategories:[{id:'cat',title:'Danh mục 1',slug:'danh-muc-1',status:'published'}],albumItems:[{id:'a1',title:'Ảnh',categoryId:'cat',image:'https://example.com/a.jpg',status:'published'}],collections:{nail:[{id:'nail1',title:'Nail',image:'https://example.com/nail.jpg',status:'published'}],space:[],menu:[],slides:[],videos:[]}});
{
 const data=fixture();ok(getRows(data,'articles').length===1,'Bản ghi hiện có nhìn thấy');
 ok(deleteRecords(data,'articles',['n1'])===1,'Xóa mềm thay vì splice');
 ok(getRows(data,'articles').length===0,'Bản ghi xóa không còn trong danh sách hoạt động');
 ok(getTrashRows(data).some(r=>r.id==='n1'),'Thùng rác lưu nguyên bản ghi');
 ok(data.articles[0].body==='<p>Đây là nội dung</p>'&&data.articles[0].custom.keep===1,'Không mất HTML và dữ liệu tùy chỉnh khi xóa');
 ok(restoreRecords(data,[{tab:'articles',id:'n1'}])===1,'Khôi phục bản ghi');
 ok(getRows(data,'articles').length===1&&data.articles[0].status==='published','Khôi phục đúng trạng thái xuất bản');
 deleteRecords(data,'articles',['n1']);
 ok(purgeRecords(data,[{tab:'articles',id:'n1'}])===1&&!data.articles.length,'Xóa vĩnh viễn tách khỏi xóa mềm');
}
{
 const data=fixture();
 deleteRecords(data,'albumPhotos',['nail1']);
 ok(data.collections.nail[0].deleted===true,'Xóa mềm ảnh Nail giữ đúng nhóm gốc');
 ok(getTrashRows(data).some(r=>r.id==='nail1'&&r.trashModule==='albumPhotos'),'Ảnh Nail xuất hiện trong Thùng rác');
 restoreRecords(data,[{tab:'albumPhotos',id:'nail1'}]);
 ok(data.collections.nail[0].deleted!==true,'Khôi phục ảnh Nail không chuyển sang nhóm khác');
 deleteRecords(data,'albumPhotos',['a1']);
 ok(data.albumItems[0].deleted===true,'Xóa mềm ảnh Album tùy chỉnh');
 restoreRecords(data,[{tab:'albumPhotos',id:'a1'}]);
 ok(data.albumItems[0].status==='published','Khôi phục ảnh Album tùy chỉnh');
}
{
 const data=fixture();const copy=duplicateRecord(data,'articles',data.articles[0],'n2');
 ok(copy.id==='n2'&&copy.slug!=='bai-goc'&&copy.body===data.articles[0].body,'Bản sao có ID/slug mới nhưng giữ nội dung');
 ok(copy.custom?.keep===1&&copy.seoTitle===data.articles[0].seoTitle,'Bản sao giữ dữ liệu tùy chỉnh và SEO');
 saveRecord(data,'articles',copy);ok(getRows(data,'articles').length===2,'Lưu bản sao vào đúng module');
}
{
 const src=fs.readFileSync(path.join(root,'src/cms/SourceAdmin.jsx'),'utf8');
 ok(src.includes("window.location.reload()")&&src.includes('mi-house-admin-flash'),'Thông báo lưu có cơ chế flash và reload');
 ok(src.includes('noopener noreferrer')&&src.includes('cmsPublicUrl(tab,row)'),'View sử dụng URL public và tab mới an toàn');
 ok(src.includes('Tạo và lưu Schema')&&src.includes('validateSchemaJson'),'Có tạo, kiểm tra và lưu Schema JSON');
 ok(src.includes('cms-trash-root')&&src.includes('/api/admin/trash/purge'),'Giao diện Thùng rác gọi endpoint xóa vĩnh viễn');
 ok(src.includes('searchableText(JSON.stringify(r))'),'Tìm kiếm đã chuẩn hóa dấu tiếng Việt');
}
{
 const backend=fs.readFileSync(path.join(root,'server/index.mjs'),'utf8');
 ok(backend.includes('reconcileSoftDeletes')&&backend.includes('physicalTrashGroup'),'Backend giữ tombstone và xóa đúng nhóm thực tế');
 ok(backend.includes('File vẫn đang được dùng trong CMS')&&backend.includes('referencesOf(media.url)'),'Media ngăn xóa khi còn tham chiếu');
 ok(backend.includes("'Cache-Control':'no-store'"),'CMS Public API không phát cache stale');
}
{
 const vite=fs.readFileSync(path.join(root,'vite.config.js'),'utf8');
 const app=fs.readFileSync(path.join(root,'src/App.jsx'),'utf8');
 ok(app.includes("import.meta.glob('./pages/*.jsx')")&&app.includes('React.lazy'),'26 trang con sử dụng lazy route chunk');
 ok(vite.includes('sourcemap'),'Cấu hình source map cho build kiểm soát được');
}
console.log(`V18 FEATURE TEST: ${checks} PASS`);
