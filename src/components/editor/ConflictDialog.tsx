import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

interface ConflictDialogProps {
  path: string;
  onKeepMine: () => void;
  onLoadRemote: () => void;
}

export function ConflictDialog({ path, onKeepMine, onLoadRemote }: ConflictDialogProps) {
  const { t } = useTranslation();
  const fileName = path.split('/').pop() ?? path;

  return (
    <Dialog open>
      <DialogContent
        className="max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
            {t('conflict.title')}
          </DialogTitle>
          <DialogDescription>
            {t('conflict.description', { name: fileName })}
          </DialogDescription>
        </DialogHeader>
        <div className="px-4 pb-2 text-xs text-muted-foreground">
          {t('conflict.hint')}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onLoadRemote}>
            {t('conflict.loadRemote')}
          </Button>
          <Button variant="default" onClick={onKeepMine}>
            {t('conflict.keepMine')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
