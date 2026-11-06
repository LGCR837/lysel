export type OneBotCall = (action: string, params?: Record<string, unknown>) => Promise<any>;

export function createOneBotApi(call: OneBotCall) {
  return {
    loginInfo: () => call('get_login_info'),
    sendPrivate: (userId: string, message: unknown) =>
      call('send_private_msg', { user_id: Number(userId), message }),
    sendGroup: (groupId: string, message: unknown) =>
      call('send_group_msg', { group_id: Number(groupId), message }),
    deleteMsg: (messageId: string) => call('delete_msg', { message_id: Number(messageId) }),
    strangerInfo: (userId: string) => call('get_stranger_info', { user_id: Number(userId) }),
    groupMemberList: (groupId: string) => call('get_group_member_list', { group_id: Number(groupId) }),
  };
}

export type OneBotApi = ReturnType<typeof createOneBotApi>;
