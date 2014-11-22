class Gift < ActiveRecord::Base
  belongs_to :list
  
  def url
    "/#{list.try(:id)}"
  end
  
  def edit_link
    "/gifts/edit/#{id}"
  end
end