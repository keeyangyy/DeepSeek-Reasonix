package control

import (
	"testing"

	"reasonix/internal/event"
)

// 压缩期间 RuntimeStatus.Running 必须为 true。
//
// 压缩不产生 turn 事件，但它是实打实在跑的工作：如果 Running 在旋转期间是
// false，「是否有活动工作」的判定会把压缩当成空闲，切回会话时重建 controller
// 并清掉会话列表的进行中状态，表现为「压缩还在跑，转圈却没了」。
//
// 注意 Cancellable 仍按原始 running 计算，所以压缩期间不会冒出「停止」按钮。
func TestRuntimeStatusReportsRotation(t *testing.T) {
	c := New(Options{Sink: event.FuncSink(func(event.Event) {})})

	if st := c.RuntimeStatus(); st.Running {
		t.Fatalf("idle Running = true, want false")
	}

	if err := c.beginRotation(); err != nil {
		t.Fatalf("beginRotation: %v", err)
	}
	st := c.RuntimeStatus()
	if !st.Running {
		t.Fatalf("rotation in progress: Running = false, want true（否则切回会话会被判空闲并重建 controller）")
	}
	if st.Cancellable {
		t.Fatalf("rotation in progress: Cancellable = true, want false（压缩不该出现停止按钮）")
	}

	c.endRotation()
	if st := c.RuntimeStatus(); st.Running {
		t.Fatalf("after endRotation: Running = true, want false")
	}
}
