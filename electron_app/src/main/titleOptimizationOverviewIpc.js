function registerTitleOptimizationOverviewIpc(ipcMain, service){ipcMain.handle('title-optimization-overview:load',async()=>{try{return{success:true,data:await service.load()};}catch(error){return{success:false,error:{code:error?.code||'OVERVIEW_ERROR',message:String(error?.message||'Unable to load Title Optimization overview.')}};}});}
module.exports={registerTitleOptimizationOverviewIpc};
