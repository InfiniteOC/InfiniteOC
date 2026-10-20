package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// Event is one frame of GET /api/event.
type Event struct {
	ID       string          `json:"id"`
	Created  int64           `json:"created"`
	Type     string          `json:"type"`
	Location *Location       `json:"location,omitempty"`
	Data     json.RawMessage `json:"data"`
}

// Synthetic event types the stream emits besides server ones.
const (
	EventDisconnected = "client.disconnected"
	EventConnected    = "server.connected"
)

// Stream delivers events until ctx ends, reconnecting after failures. The server's stream is
// volatile: after every server.connected the caller must re-fetch state.
func (c *Client) Stream(ctx context.Context, out chan<- Event) {
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := c.streamOnce(ctx, out)
		if ctx.Err() != nil {
			return
		}
		msg, _ := json.Marshal(map[string]string{"error": errString(err)})
		select {
		case out <- Event{Type: EventDisconnected, Data: msg}:
		case <-ctx.Done():
			return
		}
		if time.Since(start) > 10*time.Second {
			backoff = time.Second
		}
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		}
		backoff = min(backoff*2, 8*time.Second)
	}
}

func errString(err error) string {
	if err == nil {
		return "stream closed"
	}
	return err.Error()
}

func (c *Client) streamOnce(ctx context.Context, out chan<- Event) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/api/event", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	if c.auth != "" {
		req.Header.Set("Authorization", c.auth)
	}
	res, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return &APIError{Status: res.StatusCode, Message: res.Status}
	}

	// Idle watchdog: the server sends a heartbeat every 15s.
	alive := make(chan struct{}, 1)
	go func() {
		t := time.NewTimer(45 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-alive:
				if !t.Stop() {
					<-t.C
				}
				t.Reset(45 * time.Second)
			case <-t.C:
				cancel()
				return
			}
		}
	}()

	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64*1024), 17<<20)
	var data bytes.Buffer
	for sc.Scan() {
		select {
		case alive <- struct{}{}:
		default:
		}
		line := sc.Bytes()
		switch {
		case len(line) == 0:
			if data.Len() == 0 {
				continue
			}
			var ev Event
			if err := json.Unmarshal(data.Bytes(), &ev); err == nil {
				select {
				case out <- ev:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			data.Reset()
		case line[0] == ':':
			// heartbeat comment
		case bytes.HasPrefix(line, []byte("data:")):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.Write(bytes.TrimPrefix(bytes.TrimPrefix(line, []byte("data:")), []byte(" ")))
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return nil
}
