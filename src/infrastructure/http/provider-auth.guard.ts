import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";

/**
 * Ponto de extensão para autenticação dos provedores.
 *
 * A implementação do desafio permite acesso sem credenciais.
 * Ela não autentica identidades nem valida autorização.
 *
 * Uma implementação real pode usar o ExecutionContext
 * para validar API key, assinatura ou token e verificar
 * se o provedor pode acessar o recurso solicitado.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}