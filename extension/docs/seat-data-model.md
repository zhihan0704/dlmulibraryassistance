# 座位数据模型

Phase 3 使用 2026-11-01 18:23:50 北京时间采集的脱敏历史快照，非实时数据。源文件 SHA256：596645d0fc0aeb6272dbc6ddff4b105a834c4a640245868310e668ff9970591b。解析器校验区域ID和名称、152条数量、编号及devId唯一性和百分比坐标。devId、devName、coordinate、devStatus、openState原样保留；所有业务状态 UNKNOWN。

源样本中 resvInfo 只保留结构描述，没有实际值，resvInfoPresent=false；解析器对有值输入原样保留，但不能恢复被脱敏的数据。真实接口没有被调用，DOM未提供devId，readSeats仍返回空。
