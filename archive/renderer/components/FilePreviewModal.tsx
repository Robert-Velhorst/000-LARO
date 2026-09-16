/**
 * File Preview Modal Component
 * Displays PDFs and images with zoom controls, download, and image comparison.
 */

import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import FileComparisonView from './FileComparisonView';
import {
  ZoomIn,
  ZoomOut,
  Download,
  X,
  Loader2,
  AlertCircle,
  FileText,
  Eye,
  Columns,
} from 'lucide-react';

interface FilePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  file?: {
    id: string;
    fileName: string;
    fileUrl: string;
    mimeType: string;
    itemType: string;
  };
  caseId?: string;
}

type ViewMode = 'preview' | 'compare';

export default function FilePreviewModal({ isOpen, onClose, file, caseId }: FilePreviewModalProps) {
  const [zoom, setZoom] = useState(100);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [showComparison, setShowComparison] = useState(false);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setZoom(100);
      setError(null);
      setIsLoading(true);
      setViewMode('preview');
    }
  }, [isOpen, file]);

  if (!file) return null;

  const isImage = file.mimeType.startsWith('image/');
  const isPdf = file.mimeType === 'application/pdf';
  const isSupported = isImage || isPdf;
  const supportsComparison = isImage && !!caseId;

  const handleZoomIn = () => {
    setZoom((prev) => Math.min(prev + 10, 300));
  };

  const handleZoomOut = () => {
    setZoom((prev) => Math.max(prev - 10, 50));
  };

  const handleDownload = () => {
    if (file.fileUrl) {
      const link = document.createElement('a');
      link.href = file.fileUrl;
      link.download = file.fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const handleImageLoad = () => {
    setIsLoading(false);
    setError(null);
  };

  const handleImageError = () => {
    setIsLoading(false);
    setError('Failed to load image');
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
          <DialogHeader className="flex flex-row items-center justify-between">
            <div className="flex-1">
              <DialogTitle className="truncate">{file.fileName}</DialogTitle>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-6 w-6 p-0"
            >
              <X className="w-4 h-4" />
            </Button>
          </DialogHeader>

          {/* Mode Tabs */}
          {isSupported && (
            <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="preview" className="gap-2">
                  <Eye className="w-4 h-4" />
                  <span className="hidden sm:inline">Preview</span>
                </TabsTrigger>
                <TabsTrigger value="compare" disabled={!supportsComparison} className="gap-2">
                  <Columns className="w-4 h-4" />
                  <span className="hidden sm:inline">Compare</span>
                </TabsTrigger>
              </TabsList>

              {/* Preview Tab */}
              <TabsContent value="preview" className="flex-1 mt-4">
                <div className="overflow-auto bg-gray-100 dark:bg-gray-900 rounded-lg flex items-center justify-center min-h-80">
                  {!isSupported ? (
                    <div className="flex flex-col items-center gap-3 p-8 text-center">
                      <AlertCircle className="w-12 h-12 text-yellow-500" />
                      <p className="text-sm font-medium">Preview not available</p>
                      <p className="text-xs text-gray-500">
                        This file type cannot be previewed. Click download to view it.
                      </p>
                      <Button
                        size="sm"
                        onClick={handleDownload}
                        className="mt-2 gap-2"
                      >
                        <Download className="w-4 h-4" />
                        Download File
                      </Button>
                    </div>
                  ) : isLoading ? (
                    <div className="flex flex-col items-center gap-2">
                      <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                      <p className="text-sm text-gray-500">Loading preview...</p>
                    </div>
                  ) : error ? (
                    <div className="flex flex-col items-center gap-3 p-8 text-center">
                      <AlertCircle className="w-12 h-12 text-red-500" />
                      <p className="text-sm font-medium">Error loading preview</p>
                      <p className="text-xs text-gray-500">{error}</p>
                      <Button
                        size="sm"
                        onClick={handleDownload}
                        className="mt-2 gap-2"
                      >
                        <Download className="w-4 h-4" />
                        Download File
                      </Button>
                    </div>
                  ) : isImage ? (
                    <div className="flex items-center justify-center p-4">
                      <img
                        src={file.fileUrl}
                        alt={file.fileName}
                        style={{
                          maxWidth: '100%',
                          maxHeight: '60vh',
                          width: `${zoom}%`,
                          height: 'auto',
                          transition: 'width 0.2s ease-in-out',
                        }}
                        onLoad={handleImageLoad}
                        onError={handleImageError}
                        className="object-contain"
                      />
                    </div>
                  ) : isPdf ? (
                    <div className="flex flex-col items-center gap-3 p-8 text-center">
                      <FileText className="w-12 h-12 text-blue-500" />
                      <p className="text-sm font-medium">PDF Preview</p>
                      <p className="text-xs text-gray-500">
                        PDF preview requires additional setup. Click download to view.
                      </p>
                      <Button
                        size="sm"
                        onClick={handleDownload}
                        className="mt-2 gap-2"
                      >
                        <Download className="w-4 h-4" />
                        Download PDF
                      </Button>
                    </div>
                  ) : null}
                </div>

                {/* Zoom Toolbar */}
                {isImage && !error && (
                  <div className="flex items-center justify-between gap-4 p-4 border-t mt-4">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleZoomOut}
                        disabled={zoom <= 50}
                        className="gap-1"
                      >
                        <ZoomOut className="w-4 h-4" />
                        <span className="text-xs">-</span>
                      </Button>

                      <div className="flex items-center gap-2 min-w-48">
                        <Slider
                          value={[zoom]}
                          onValueChange={(value) => setZoom(value[0])}
                          min={50}
                          max={300}
                          step={10}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium min-w-12 text-right">{zoom}%</span>
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleZoomIn}
                        disabled={zoom >= 300}
                        className="gap-1"
                      >
                        <ZoomIn className="w-4 h-4" />
                        <span className="text-xs">+</span>
                      </Button>
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDownload}
                      className="gap-2"
                    >
                      <Download className="w-4 h-4" />
                      Download
                    </Button>
                  </div>
                )}
              </TabsContent>

              {/* Compare Tab */}
              <TabsContent value="compare" className="mt-4">
                {supportsComparison && caseId && (
                  <div className="space-y-4">
                    <p className="text-sm text-gray-500">
                      Compare this file side-by-side with another file from the same case.
                    </p>
                    <Button
                      onClick={() => setShowComparison(true)}
                      className="gap-2"
                    >
                      <Columns className="w-4 h-4" />
                      Open Comparison View
                    </Button>
                  </div>
                )}
              </TabsContent>

            </Tabs>
          )}

          {/* Unsupported file type */}
          {!isSupported && (
            <div className="flex-1 overflow-auto bg-gray-100 dark:bg-gray-900 rounded-lg flex items-center justify-center min-h-80">
              <div className="flex flex-col items-center gap-3 p-8 text-center">
                <AlertCircle className="w-12 h-12 text-yellow-500" />
                <p className="text-sm font-medium">Preview not available</p>
                <p className="text-xs text-gray-500">
                  This file type cannot be previewed. Click download to view it.
                </p>
                <Button
                  size="sm"
                  onClick={handleDownload}
                  className="mt-2 gap-2"
                >
                  <Download className="w-4 h-4" />
                  Download File
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Comparison View Modal */}
      {caseId && (
        <FileComparisonView
          caseId={caseId}
          currentFile={file}
          isOpen={showComparison}
          onClose={() => setShowComparison(false)}
        />
      )}
    </>
  );
}
