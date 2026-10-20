// probe drives one prompt against a server and dumps the event stream (development aid).
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"infiniteoc/infinitui/internal/api"
)

func main() {
	c := api.New(os.Getenv("URL"), os.Getenv("PW"), os.Getenv("DIR"))
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	events := make(chan api.Event, 1024)
	go c.Stream(ctx, events)
	<-events
	id := api.NewSessionID()
	m := api.ModelRef{ProviderID: "opencode", ID: os.Getenv("MODEL")}
	s, err := c.CreateSession(ctx, id, "build", &m)
	fmt.Println("create", s.ID, err)
	if err := c.SetModel(ctx, id, m); err != nil {
		fmt.Println("model", err)
	}
	err = c.Prompt(ctx, id, api.Prompt{ID: api.NewMessageID(), Text: os.Getenv("TEXT"), Delivery: "steer"})
	fmt.Println("prompt", err)
	for ev := range events {
		d := string(ev.Data)
		if len(d) > 400 {
			d = d[:400] + "…"
		}
		fmt.Printf("%s %s\n", ev.Type, d)
		if ev.Type == "session.execution.succeeded" || ev.Type == "session.execution.failed" {
			break
		}
	}
	msgs, _, err := c.Messages(ctx, id, 50, "")
	fmt.Println("messages", len(msgs), err)
	for _, m := range msgs {
		fmt.Printf("  %s %s blocks=%d\n", m.ID, m.Type, len(m.Content))
		for _, b := range m.Content {
			st := ""
			if b.State != nil {
				st = b.State.Status + " in=" + string(b.State.Input) + " meta=" + string(b.State.Metadata)
				if len(st) > 300 {
					st = st[:300]
				}
			}
			fmt.Printf("     %s %s %q %s\n", b.Type, b.Name, trunc(b.Text), st)
		}
	}
}

func trunc(s string) string {
	if len(s) > 80 {
		return s[:80]
	}
	return s
}
