package provider

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/http2"
)

func TestHTTP2FailureClassificationDoesNotEnableRetries(t *testing.T) {
	for _, cause := range []error{
		http2.ConnectionError(http2.ErrCodeProtocol),
		http2.StreamError{StreamID: 3, Code: http2.ErrCodeProtocol},
		http2.GoAwayError{LastStreamID: 3, ErrCode: http2.ErrCodeProtocol, DebugData: "private"},
	} {
		t.Run(cause.Error(), func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: rtFunc(func(*http.Request) (*http.Response, error) { calls++; return nil, cause })}
			_, err := SendWithRetry(t.Context(), client, SendOptions{Provider: "test", Protocol: "openai"}, newDummyReq)
			diagnostic := DiagnoseFailure(fmt.Errorf("outer: %w", err))
			if calls != 1 || diagnostic.Kind != FailureKindTransportProtocol || diagnostic.TransportCode != "PROTOCOL_ERROR" || !errors.Is(err, cause) {
				t.Fatalf("calls=%d diagnostic=%+v err=%v", calls, diagnostic, err)
			}
			if ClassifyRecovery(err).Retryable {
				t.Fatal("classification changed the retry policy")
			}
		})
	}
	for _, cause := range []error{
		errors.New("connection error: PROTOCOL_ERROR"),
		errors.New("stream error: stream ID 3; PROTOCOL_ERROR"),
		errors.New("http2: server sent GOAWAY and closed the connection; LastStreamID=3, ErrCode=PROTOCOL_ERROR"),
		errors.New("invalid header field value: PROTOCOL_ERROR"),
		&APIError{Body: "connection error: PROTOCOL_ERROR", Status: 400},
		fmt.Errorf("connection error: PROTOCOL_ERROR: %w", &APIError{Status: 400}),
		context.Canceled,
	} {
		if got := DiagnoseFailure(&url.Error{Op: "Post", URL: "https://example.test", Err: cause}); got.Kind == FailureKindTransportProtocol {
			t.Fatalf("misclassified caller/provider error: %+v", got)
		}
	}
}

// waitForClientHeaders drains HTTP/2 frames from conn until the request HEADERS
// frame arrives, so a protocol error written afterwards lands on the request
// path instead of the connection-establishment path.
func waitForClientHeaders(conn io.Reader) bool {
	header := make([]byte, 9)
	for {
		if _, err := io.ReadFull(conn, header); err != nil {
			return false
		}
		length := int(header[0])<<16 | int(header[1])<<8 | int(header[2])
		if length > 0 {
			if _, err := io.CopyN(io.Discard, conn, int64(length)); err != nil {
				return false
			}
		}
		frameType := http2.FrameType(header[3])
		streamID := uint32(header[5])<<24 | uint32(header[6])<<16 | uint32(header[7])<<8 | uint32(header[8])
		switch {
		case frameType == http2.FrameHeaders && streamID&0x7fffffff != 0:
			return true
		case frameType == http2.FrameGoAway:
			return false
		}
	}
}

func TestHTTP2StdlibProtocolFailureRecordsNegotiatedTransport(t *testing.T) {
	server := httptest.NewUnstartedServer(http.NotFoundHandler())
	server.EnableHTTP2 = true
	server.Config.TLSNextProto = map[string]func(*http.Server, *tls.Conn, http.Handler){
		"h2": func(_ *http.Server, conn *tls.Conn, _ http.Handler) {
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
			if _, err := io.ReadFull(conn, make([]byte, len(http2.ClientPreface))); err != nil {
				return
			}
			// A valid initial SETTINGS frame, so the client treats the connection as
			// usable and sends its request.
			_, _ = conn.Write([]byte{0, 0, 0, 4, 0, 0, 0, 0, 0, 0})
			// Wait for the request's HEADERS before writing the illegal frame:
			// writing it first can surface as a connection failure instead of the
			// protocol failure under test (the flake seen on loaded runners).
			if !waitForClientHeaders(conn) {
				return
			}
			// An illegal DATA frame on stream zero, now that the request is in flight:
			// deterministically exercises net/http's private error type.
			_, _ = conn.Write([]byte{0, 0, 0, 0, 0, 0, 0, 0, 0})
			_, _ = io.Copy(io.Discard, conn)
		},
	}
	server.StartTLS()
	defer server.Close()
	var mu sync.Mutex
	var last RequestObservation
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	ctx = WithRequestObserver(ctx, func(v RequestObservation) { mu.Lock(); last = v; mu.Unlock() })
	_, err := SendWithRetry(ctx, server.Client(), SendOptions{}, func(ctx context.Context) (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/chat/completions?credential=private-query", nil)
	})
	if err == nil || DiagnoseFailure(err).Kind != FailureKindTransportProtocol {
		t.Fatalf("stdlib error: %T %v", err, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if last.TransportCode != "PROTOCOL_ERROR" || last.HTTPProtocol != "HTTP/2.0" || last.RemoteAddress == "" || last.Phase != "request_error" || last.ConnectedAt.IsZero() || !last.HeadersAt.IsZero() {
		t.Fatalf("lost negotiated transport evidence: %+v", last)
	}
}
