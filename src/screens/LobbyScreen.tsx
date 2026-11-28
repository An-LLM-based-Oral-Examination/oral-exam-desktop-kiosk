import type { StudentWorkstationTicket } from '../types/mf04.types'
import { formatDateTime } from '../utils/formatters'

interface LobbyScreenProps {
  ticket: StudentWorkstationTicket
  offlineDraftAvailable: boolean
  hasCompleteDraft: boolean
  refreshingTicket?: boolean
  onStart: () => Promise<void>
  onResumeSubmit: () => Promise<void>
  onRefreshTicket?: () => Promise<void>
}

export function LobbyScreen({
  ticket,
  offlineDraftAvailable,
  hasCompleteDraft,
  refreshingTicket = false,
  onStart,
  onResumeSubmit,
  onRefreshTicket,
}: LobbyScreenProps) {
  const isWaitingForExamPublish =
    ticket.questions.length === 0 ||
    ticket.shiftStatus.toLowerCase() !== 'in_progress' ||
    ticket.isExamPublished === false

  return (
    <section aria-labelledby="lobby-heading">
      <div className="ticket-hero">
        <div className="ticket-hero-copy">
          <span className="ticket-kicker">Phòng chờ thí sinh</span>
          <h2 id="lobby-heading">{ticket.sessionTitle}</h2>
          <p>
            {ticket.shiftName} · {formatDateTime(ticket.startTime)} – {formatDateTime(ticket.endTime)}
          </p>
        </div>
        <div className="seat-badge" aria-label={`Phòng ${ticket.roomLab}, số máy ${ticket.seatNumber}`}>
          <span>Số máy</span>
          <strong>{ticket.seatNumber}</strong>
          <span>Phòng {ticket.roomLab}</span>
        </div>
      </div>

      <div className="ticket-body">
        <div className="meta-grid">
          <div className="meta-tile">
            <span>Mã bộ đề</span>
            <strong>{ticket.examSetCode ?? 'Đã phân bổ'}</strong>
          </div>
          <div className="meta-tile">
            <span>Số lượng câu hỏi</span>
            <strong>
              {ticket.questions.length > 0 ? `${ticket.questions.length} câu hỏi` : 'Đang chờ phát đề'}
            </strong>
          </div>
          <div className="meta-tile">
            <span>Bản sao lưu cục bộ</span>
            <strong>{offlineDraftAvailable ? 'Đã khôi phục bản nháp' : 'Sẵn sàng lưu an toàn'}</strong>
          </div>
        </div>

        {isWaitingForExamPublish ? (
          <div className="rules-note" role="status">
            <strong>Đã điểm danh thành công:</strong> Ca thi đang ở trạng thái chờ mở hoặc chưa công bố bộ đề
            (<code>{ticket.shiftStatus}</code>). Hệ thống đang tự động kiểm tra định kỳ để nhận đề ngay khi Cán bộ
            Khảo thí mở ca.
          </div>
        ) : (
          <div className="rules-note">
            <strong>Lưu ý phòng thi:</strong> Không chuyển đổi cửa sổ hoặc thoát toàn màn hình trong lúc làm
            bài. Sau khi nộp bài, hệ thống tự niêm phong âm thanh và không hiển thị điểm tại máy thi.
          </div>
        )}

        <div className="action-bar">
          {isWaitingForExamPublish && onRefreshTicket ? (
            <button
              className="btn btn-secondary"
              type="button"
              disabled={refreshingTicket}
              onClick={onRefreshTicket}
            >
              {refreshingTicket ? 'Đang kiểm tra đề…' : 'Làm mới trạng thái đề'}
            </button>
          ) : null}
          <button
            className="btn btn-primary"
            type="button"
            disabled={isWaitingForExamPublish}
            onClick={hasCompleteDraft ? onResumeSubmit : onStart}
          >
            {isWaitingForExamPublish
              ? 'Đang chờ mở ca & phát đề…'
              : hasCompleteDraft
                ? 'Gửi lại bản nháp đã lưu →'
                : 'Bắt đầu làm bài →'}
          </button>
        </div>
      </div>
    </section>
  )
}
