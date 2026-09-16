/**
 * File Comparison View Component
 * Side-by-side comparison of two files
 */

import React, { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Columns,
  ZoomIn,
  ZoomOut,
  X,
  FileText,
  Image,
  Video,
  Music,
} from 'lucide-react';

interface FileItem {
  id: string;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  itemType: string;
}

interface FileComparisonViewProps {
  caseId: string;
  currentFile: FileItem;
  isOpen: boolean;
  onClose: () => void;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return <Image className="w-4 h-4" />;
  if (mimeType.startsWith('video/')) return <Video className="w-4 h-4" />;
  if (mimeType.startsWith('audio/')) return <Music className="w-4 h-4" />;
  return <FileText className="w-4 h-4" />;
}

export default function FileComparisonView({
  caseId,
  currentFile,
  isOpen,
  onClose,
}: FileComparisonViewProps) {
  const [compareFile, setCompareFile] = useState<FileItem | null>(null);
  const [zoom, setZoom] = useState(100);

  // Fetch all files for this case
  const { data: filesData, isLoading } = trpc.bulkFileOperations.getCaseItems.useQuery({
    caseId,
  });

  // Filter out current file from comparison options
  const availableFiles = filesData?.items?.filter(
    (f) => f.id !== currentFile.id && f.mimeType.startsWith('image/')
  ) || [];

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 10, 200));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 10, 50));

  const isImageFile = (mimeType: string) => mimeType.startsWith('image/');

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Columns className="w-5 h-5 text-blue-500" />
              <DialogTitle>Compare Files</DialogTitle>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </DialogHeader>

        {/* Toolbar */}
        <div className="flex items-center justify-between gap-4 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
          {/* File Selector */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">Compare with:</span>
            <Select
              value={compareFile?.id || ''}
              onValueChange={(id) => {
                const file = availableFiles.find((f) => f.id === id);
                setCompareFile(file || null);
              }}
            >
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select a file to compare" />
              </SelectTrigger>
              <SelectContent>
                {availableFiles.length === 0 ? (
                  <div className="p-2 text-sm text-gray-500">
                    No other image files available
                  </div>
                ) : (
                  availableFiles.map((file) => (
                    <SelectItem key={file.id} value={file.id}>
                      <div className="flex items-center gap-2">
                        {getFileIcon(file.mimeType)}
                        <span className="truncate max-w-48">{file.fileName}</span>
                      </div>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Zoom Controls */}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleZoomOut} disabled={zoom <= 50}>
              <ZoomOut className="w-4 h-4" />
            </Button>
            <div className="flex items-center gap-2 min-w-32">
              <Slider
                value={[zoom]}
                onValueChange={(value) => setZoom(value[0])}
                min={50}
                max={200}
                step={10}
                className="flex-1"
              />
              <span className="text-sm font-medium min-w-10">{zoom}%</span>
            </div>
            <Button variant="outline" size="sm" onClick={handleZoomIn} disabled={zoom >= 200}>
              <ZoomIn className="w-4 h-4" />
            </Button>
          </div>

        </div>

        {/* Comparison View */}
        <div className="flex-1 grid grid-cols-2 gap-4 overflow-hidden">
          {/* Left Panel - Current File */}
          <div className="flex flex-col border rounded-lg overflow-hidden">
            <div className="p-2 bg-gray-100 dark:bg-gray-800 border-b">
              <div className="flex items-center gap-2">
                {getFileIcon(currentFile.mimeType)}
                <span className="text-sm font-medium truncate">{currentFile.fileName}</span>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
              {isImageFile(currentFile.mimeType) ? (
                <img
                  src={currentFile.fileUrl}
                  alt={currentFile.fileName}
                  style={{
                    width: `${zoom}%`,
                    height: 'auto',
                    maxWidth: '100%',
                    objectFit: 'contain',
                  }}
                  className="transition-all duration-200"
                />
              ) : (
                <div className="flex flex-col items-center gap-2 text-gray-500">
                  <FileText className="w-12 h-12" />
                  <p className="text-sm">Preview not available</p>
                </div>
              )}
            </div>
          </div>

          {/* Right Panel - Compare File */}
          <div className="flex flex-col border rounded-lg overflow-hidden">
            <div className="p-2 bg-gray-100 dark:bg-gray-800 border-b">
              {compareFile ? (
                <div className="flex items-center gap-2">
                  {getFileIcon(compareFile.mimeType)}
                  <span className="text-sm font-medium truncate">{compareFile.fileName}</span>
                </div>
              ) : (
                <span className="text-sm text-gray-500">Select a file to compare</span>
              )}
            </div>
            <div className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
              {compareFile ? (
                isImageFile(compareFile.mimeType) ? (
                  <img
                    src={compareFile.fileUrl}
                    alt={compareFile.fileName}
                    style={{
                      width: `${zoom}%`,
                      height: 'auto',
                      maxWidth: '100%',
                      objectFit: 'contain',
                    }}
                    className="transition-all duration-200"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-gray-500">
                    <FileText className="w-12 h-12" />
                    <p className="text-sm">Preview not available</p>
                  </div>
                )
              ) : (
                <div className="flex flex-col items-center gap-3 text-gray-400">
                  <Columns className="w-16 h-16" />
                  <p className="text-sm">Select a file from the dropdown above</p>
                  <p className="text-xs">to compare side-by-side</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Info Footer */}
        <div className="flex items-center justify-between text-xs text-gray-500 pt-2 border-t">
          <span>
            Tip: Use the zoom slider to adjust both images simultaneously
          </span>
          <span>
            {availableFiles.length} other file{availableFiles.length !== 1 ? 's' : ''} available for comparison
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
