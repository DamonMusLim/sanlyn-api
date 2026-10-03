-- M145 摄像头日报写权限补授(jarvis_writer INSERT petstore_vision_dna)
-- 摄像头日报 MEM-0028 自 9/8 起报 permission denied for table petstore_vision_dna:
-- 该表 9/7 由管理员建,漏给 jarvis_writer 写权限(只读能查,不能插)。
-- 只补 INSERT,不放宽其它权限。幂等:GRANT 重复执行无副作用。
GRANT INSERT ON TABLE petstore_vision_dna TO jarvis_writer;
-- id 是 serial(nextval petstore_vision_dna_id_seq),插入还需要序列使用权
GRANT USAGE ON SEQUENCE petstore_vision_dna_id_seq TO jarvis_writer;
