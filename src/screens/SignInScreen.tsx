import { useState } from 'react'
import type { FormEvent } from 'react'

interface SignInScreenProps {
  username: string
  password: string
  newPassword: string
  mustChangePassword: boolean
  busy: boolean
  runtimeReady: boolean
  runtimeError?: string
  appVersion: string
  isKioskMode: boolean
  onUsername: (value: string) => void
  onPassword: (value: string) => void
  onNewPassword: (value: string) => void
  onLogin: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onChangePassword: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onCancelChangePassword: () => void
  onRetryRuntime?: () => void
}

export function SignInScreen({
  username,
  password,
  newPassword,
  mustChangePassword,
  busy,
  runtimeReady,
  runtimeError,
  appVersion,
  isKioskMode,
  onUsername,
  onPassword,
  onNewPassword,
  onLogin,
  onChangePassword,
  onCancelChangePassword,
  onRetryRuntime,
}: SignInScreenProps) {
  const [showPassword, setShowPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)

  if (!runtimeReady) {
    return (
      <section className="card-elevated" aria-labelledby="signin-heading">
        <div className="auth-header">
          <div className="auth-emblem" aria-hidden="true">
            OE
          </div>
          <h1 id="signin-heading">
            {runtimeError ? 'Không thể khởi tạo Kiosk' : 'Đang khởi tạo môi trường Kiosk'}
          </h1>
          <p>
            {runtimeError
              ? runtimeError
              : 'Hệ thống đang xác minh định danh thiết bị và cấu hình máy chủ phòng thi an toàn…'}
          </p>
        </div>

        <div className="runtime-gate" role="status" aria-live="polite">
          {runtimeError ? (
            <button
              className="btn btn-secondary btn-full"
              type="button"
              onClick={onRetryRuntime}
            >
              Thử khởi tạo lại
            </button>
          ) : (
            <div className="runtime-gate-loading">
              <span className="practice-status-spinner" aria-hidden="true" />
              <span>Đang đồng bộ định danh thiết bị BYOD…</span>
            </div>
          )}
        </div>

        <div className="auth-footer">
          <span>{isKioskMode ? 'Chế độ khóa Kiosk' : 'Đang kiểm tra môi trường'}</span>
          <span>Phiên bản {appVersion}</span>
        </div>
      </section>
    )
  }

  return (
    <section className="card-elevated" aria-labelledby="signin-heading">
      <div className="auth-header">
        <div className="auth-emblem" aria-hidden="true">
          OE
        </div>
        <h1 id="signin-heading">{mustChangePassword ? 'Đổi mật khẩu bắt buộc' : 'Đăng nhập phòng thi'}</h1>
        <p>
          {mustChangePassword
            ? 'Tài khoản cần cập nhật mật khẩu mới trước khi vào phòng thi.'
            : 'Sử dụng tài khoản sinh viên do nhà trường cấp để nhận vé thi.'}
        </p>
      </div>

      <form className="form-stack" onSubmit={mustChangePassword ? onChangePassword : onLogin}>
        <label className="field" htmlFor="username">
          <span className="field-label">Tên đăng nhập</span>
          <input
            id="username"
            className="field-input"
            value={username}
            onChange={(event) => onUsername(event.target.value)}
            autoComplete="username"
            placeholder="Nhập tên đăng nhập sinh viên"
            disabled={mustChangePassword}
            autoFocus={!mustChangePassword}
          />
        </label>

        <label className="field" htmlFor="password">
          <span className="field-label">{mustChangePassword ? 'Mật khẩu hiện tại' : 'Mật khẩu'}</span>
          <div className="password-wrap">
            <input
              id="password"
              className="field-input"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => onPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="Nhập mật khẩu"
              disabled={mustChangePassword}
            />
            {!mustChangePassword ? (
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
              >
                {showPassword ? 'Ẩn' : 'Hiện'}
              </button>
            ) : null}
          </div>
        </label>

        {mustChangePassword ? (
          <label className="field" htmlFor="new-password">
            <span className="field-label">Mật khẩu mới</span>
            <div className="password-wrap">
              <input
                id="new-password"
                className="field-input"
                type={showNewPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(event) => onNewPassword(event.target.value)}
                autoComplete="new-password"
                placeholder="Tối thiểu 8 ký tự"
                autoFocus
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowNewPassword((prev) => !prev)}
                aria-label={showNewPassword ? 'Ẩn mật khẩu mới' : 'Hiện mật khẩu mới'}
              >
                {showNewPassword ? 'Ẩn' : 'Hiện'}
              </button>
            </div>
            <p className="field-hint">Mật khẩu mới cần có ít nhất 8 ký tự.</p>
          </label>
        ) : null}

        <button className="btn btn-primary btn-full" type="submit" disabled={busy}>
          {busy ? 'Đang xác thực…' : mustChangePassword ? 'Đổi mật khẩu và tiếp tục' : 'Đăng nhập'}
        </button>

        {mustChangePassword ? (
          <button
            className="btn btn-secondary btn-full"
            type="button"
            onClick={onCancelChangePassword}
            disabled={busy}
          >
            Quay lại đăng nhập
          </button>
        ) : null}
      </form>

      <div className="auth-footer">
        <span>{isKioskMode ? 'Chế độ khóa Kiosk' : 'Chế độ thử nghiệm'}</span>
        <span>Phiên bản {appVersion}</span>
      </div>
    </section>
  )
}
