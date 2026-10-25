package api

// CloseEvents 在数据库关闭前断开并等待全部 WebSocket 处理结束。
func (s *Server) CloseEvents() { s.hub.Close(); s.eventWG.Wait() }
