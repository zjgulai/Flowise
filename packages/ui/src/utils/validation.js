import { z } from 'zod/v3'

export const passwordSchema = z
    .string()
    .min(8, '密码必须至少为 8 个字符')
    .max(128, '密码不得超过 128 个字符')
    .regex(/[a-z]/, '密码必须包含至少一个小写字母')
    .regex(/[A-Z]/, '密码必须包含至少一个大写字母')
    .regex(/\d/, '密码必须包含至少一个数字')
    .regex(/[^a-zA-Z0-9]/, '密码必须包含至少一个特殊字符')

export const validatePassword = (password) => {
    const result = passwordSchema.safeParse(password)
    if (!result.success) {
        return result.error.errors.map((err) => err.message)
    }
    return []
}
