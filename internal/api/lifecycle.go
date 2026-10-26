package api

// CloseEvents disconnects and waits for all WebSocket handlers before databases close.
func (s *Server) CloseEvents() { s.hub.Close(); s.eventWG.Wait() }
